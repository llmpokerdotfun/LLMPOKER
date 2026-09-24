/**
 * Live monitor feed (FR-7.5): one WebSocket, applied as deltas to in-memory
 * state, with automatic reconnect + backoff and a 3 s polling fallback whenever
 * the socket is not `LIVE`.
 *
 * Pages never talk to the socket directly: they `subscribe()` and re-render,
 * which keeps the staleness budget in one place (≤ 2 s target, 3 s fallback).
 */

import { getAgents, getTables, monitorSocketUrl } from './api.js';
import {
  OFFLINE_AFTER_ATTEMPTS,
  PING_INTERVAL_MS,
  POLL_INTERVAL_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  SOCKET_SILENCE_TIMEOUT_MS,
} from './constants.js';
import { parseChips } from './format.js';
import { setChromeInfo, setConnectionIndicator } from './ui.js';

/**
 * @typedef {import('./types.js').ActionRequest} ActionRequest
 * @typedef {import('./types.js').AgentSnapshot} AgentSnapshot
 * @typedef {import('./types.js').HandResult} HandResult
 * @typedef {import('./types.js').HandSummary} HandSummary
 * @typedef {import('./types.js').Mode} Mode
 * @typedef {import('./types.js').MonitorEvent} MonitorEvent
 * @typedef {import('./types.js').ServerMessage} ServerMessage
 * @typedef {import('./types.js').TableEvent} TableEvent
 * @typedef {import('./types.js').TableEventEnvelope} TableEventEnvelope
 * @typedef {import('./types.js').TableSnapshot} TableSnapshot
 */

/**
 * @typedef {'LIVE'|'RECONNECTING'|'OFFLINE'} ConnectionState
 */

/**
 * @typedef {Object} LiveState
 * @property {ConnectionState} connection
 * @property {AgentSnapshot[]} agents
 * @property {TableSnapshot[]} tables
 * @property {HandSummary[]} completedHands Hands derived from live deltas (may be replaced by authoritative API rows).
 * @property {number|null} updatedAt
 * @property {number|null} serverTime
 * @property {number|null} chainId
 * @property {string|null} version
 * @property {number|null} latencyMs
 * @property {number} reconnectAttempts
 * @property {string|null} lastError
 * @property {boolean} snapshotLoaded
 */

/** @type {LiveState} */
export const state = {
  connection: 'OFFLINE',
  agents: [],
  tables: [],
  completedHands: [],
  updatedAt: null,
  serverTime: null,
  chainId: null,
  version: null,
  latencyMs: null,
  reconnectAttempts: 0,
  lastError: null,
  snapshotLoaded: false,
};

/** @type {Set<(s: LiveState) => void>} */
const listeners = new Set();
/** @type {Set<(summary: HandSummary, result: HandResult) => void>} */
const handListeners = new Set();
/** @type {Map<string, ActionRequest>} */
const actionRequests = new Map();
/**
 * Deck positions this client has seen revealed (FR-6.3), per table, from
 * `CARD_REVEALED` deltas on this connection. Positions absent from the set stay
 * hidden commitments — the feed never carries their card values at all.
 *
 * @type {Map<string, Set<number>>}
 */
const revealedPositions = new Map();

/** @type {WebSocket|null} */
let socket = null;
/** @type {number|null} */
let pingTimer = null;
/** @type {number|null} */
let pollTimer = null;
/** @type {number|null} */
let reconnectTimer = null;
/** @type {number|null} */
let watchdogTimer = null;
/** @type {number|null} */
let emitTimer = null;
let pingSentAt = 0;
let lastMessageAt = 0;
let started = false;

/** @returns {LiveState} the live state object (do not mutate from outside). */
export function getState() {
  return state;
}

/**
 * @param {(s: LiveState) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fired for every completed hand seen on the feed, **before** it can be
 * confirmed against `/api/v1/hands` (FR-7.5 delta application).
 *
 * @param {(summary: HandSummary, result: HandResult) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onHandComplete(listener) {
  handListeners.add(listener);
  return () => {
    handListeners.delete(listener);
  };
}

/** @param {string} tableId @returns {ActionRequest|null} */
export function getActionRequest(tableId) {
  return actionRequests.get(tableId) ?? null;
}

/**
 * Deck positions seen revealed for a table on **this** connection (FR-6.3).
 * `null` when nothing has been revealed yet; the count is a lower bound, since
 * a reconnect starts over (the authoritative list is `proof.reveals` on
 * `/api/v1/hands/:id`).
 *
 * @param {string} tableId
 * @returns {Set<number>|null}
 */
export function getRevealedPositions(tableId) {
  return revealedPositions.get(tableId) ?? null;
}

/** @param {string} tableId @returns {TableSnapshot|null} */
export function getTable(tableId) {
  return state.tables.find((t) => t.id === tableId) ?? null;
}

/** @param {string} agentId @returns {AgentSnapshot|null} */
export function getAgent(agentId) {
  return state.agents.find((a) => a.id === agentId) ?? null;
}

/** @param {string|null|undefined} agentId @returns {string} display name or the id */
export function agentName(agentId) {
  if (!agentId) return '—';
  return getAgent(agentId)?.name ?? agentId;
}

/**
 * The mode an agent is currently playing in. `AgentSnapshot` has no `mode`
 * field, so it is derived (documented guess):
 *  1. the mode of the table it is seated at, else
 *  2. `WAGER` when it holds escrow, else `FREE` when it holds play chips.
 *
 * @param {AgentSnapshot} agent
 * @returns {Mode|null}
 */
export function modeForAgent(agent) {
  if (agent.seatedAt) {
    const table = getTable(agent.seatedAt.tableId);
    if (table) return table.mode;
  }
  const escrow = parseChips(agent.escrow);
  if (escrow !== null && escrow > 0n) return 'WAGER';
  const free = parseChips(agent.freeChips);
  if (free !== null && free > 0n) return 'FREE';
  return null;
}

/**
 * Starts the monitor feed. Idempotent.
 *
 * @returns {() => void} stop function
 */
export function startLive() {
  if (started) return stopLive;
  started = true;
  setConnection('RECONNECTING');
  startPolling();
  connect();
  watchdogTimer = window.setInterval(checkSocketHealth, 5000);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onNetworkOnline);
  window.addEventListener('offline', onNetworkOffline);
  return stopLive;
}

/** Stops the feed and clears every timer. */
export function stopLive() {
  started = false;
  stopPing();
  stopPolling();
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (watchdogTimer !== null) window.clearInterval(watchdogTimer);
  watchdogTimer = null;
  if (socket) {
    const closing = socket;
    socket = null;
    try {
      closing.close();
    } catch {
      /* already closed */
    }
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('online', onNetworkOnline);
  window.removeEventListener('offline', onNetworkOffline);
  setConnection('OFFLINE');
}

// ---------------------------------------------------------------------------
// State mutation + notification
// ---------------------------------------------------------------------------

/**
 * @param {ConnectionState} connection
 * @param {number} [attempts]
 * @returns {void}
 */
function setConnection(connection, attempts) {
  const changed = state.connection !== connection;
  state.connection = connection;
  if (typeof attempts === 'number') state.reconnectAttempts = attempts;
  setConnectionIndicator(
    connection,
    connection === 'LIVE'
      ? 'Connected to the monitor WebSocket feed'
      : connection === 'RECONNECTING'
        ? 'WebSocket down — reconnecting with backoff, polling every 3 s'
        : 'WebSocket unavailable — polling /api/v1 every 3 s',
  );
  if (changed) emitNow();
}

/** Coalesces bursty delta re-renders. */
function scheduleEmit() {
  if (emitTimer !== null) return;
  emitTimer = window.setTimeout(() => {
    emitTimer = null;
    emitNow();
  }, 80);
}

function emitNow() {
  for (const listener of Array.from(listeners)) {
    try {
      listener(state);
    } catch (err) {
      console.error('[monitor] listener failed', err);
    }
  }
}

/**
 * @param {HandSummary} summary
 * @param {HandResult} result
 * @returns {void}
 */
function emitHand(summary, result) {
  // The same hand can arrive twice (a `MONITOR_EVENT.HAND_COMPLETE` and the
  // table-scoped `TABLE_EVENT`); keep one row per handId.
  const duplicate = state.completedHands.some((row) => row.handId === summary.handId);
  if (!duplicate) {
    state.completedHands.unshift(summary);
    if (state.completedHands.length > 25) state.completedHands.length = 25;
  }
  for (const listener of Array.from(handListeners)) {
    try {
      listener(summary, result);
    } catch (err) {
      console.error('[monitor] hand listener failed', err);
    }
  }
}

/** @param {AgentSnapshot} agent */
function upsertAgent(agent) {
  if (!agent || typeof agent.id !== 'string') return;
  const index = state.agents.findIndex((a) => a.id === agent.id);
  if (index === -1) state.agents.push(agent);
  else state.agents[index] = agent;
}

/** @param {TableSnapshot} table */
function upsertTable(table) {
  if (!table || typeof table.id !== 'string') return;
  const index = state.tables.findIndex((t) => t.id === table.id);
  if (index === -1) state.tables.push(table);
  else state.tables[index] = table;
}

/**
 * Applies one `MonitorEvent` to in-memory state.
 *
 * @param {MonitorEvent} event
 * @returns {void}
 */
export function applyMonitorEvent(event) {
  if (!event || typeof event.kind !== 'string') return;
  switch (event.kind) {
    case 'AGENT_UPDATED':
      if (event.agent) upsertAgent(event.agent);
      break;
    case 'TABLE_UPDATED':
      if (event.table) upsertTable(event.table);
      break;
    case 'TABLE_EVENT':
      if (event.tableId && event.envelope) applyTableEvent(event.tableId, event.envelope);
      break;
    case 'HAND_COMPLETE':
      if (event.result) {
        const summary = summarizeHandResult(event.result);
        emitHand(summary, event.result);
      }
      break;
    default:
      break;
  }
  state.updatedAt = Date.now();
  scheduleEmit();
}

/**
 * Applies a table-scoped delta. Fields the event does not carry are left to the
 * next `TABLE_UPDATED` / `MONITOR_SNAPSHOT`, which the server sends frequently
 * enough to hold the ≤ 2 s staleness target.
 *
 * @param {string} tableId
 * @param {TableEventEnvelope} envelope
 * @returns {void}
 */
export function applyTableEvent(tableId, envelope) {
  const table = getTable(tableId);
  if (!table) return;
  const payload = envelope.payload;
  if (!payload || typeof payload.type !== 'string') return;
  applyTableEventPayload(tableId, table, payload);
}

/**
 * @param {string} tableId
 * @param {TableSnapshot} table
 * @param {TableEvent} payload
 * @returns {void}
 */
function applyTableEventPayload(tableId, table, payload) {
  switch (payload.type) {
    case 'TABLE_STATE':
      upsertTable(payload.table);
      return;
    case 'RNG_SEED_COMMITTED':
      // FR-6.1 phase 1: the commitment is public, the seed is not — and nothing
      // on the wire carries it, so no page can leak it.
      table.rngCommitment = payload.commitment;
      table.rngPhase = 'SEED_COMMITTED';
      break;
    case 'RNG_DECK_COMMITTED':
      // FR-6.2 phase 2: the Merkle root only; the ordering and salts stay secret.
      table.rngDeckRoot = payload.deckRoot;
      table.rngPhase = 'DECK_COMMITTED';
      break;
    case 'CARD_REVEALED': {
      // FR-6.3 phase 3: record the position, never a hidden card. Only the
      // cards the rules made public ever arrive here.
      const reveal = payload.reveal;
      if (reveal && Number.isInteger(reveal.index)) {
        let positions = revealedPositions.get(tableId);
        if (!positions) {
          positions = new Set();
          revealedPositions.set(tableId, positions);
        }
        positions.add(reveal.index);
      }
      break;
    }
    case 'RNG_AUDITED': {
      // FR-6.4 phase 4: the hand is over, so the audit is public.
      const audit = payload.proof;
      if (audit) {
        table.rngCommitment = audit.commitment;
        table.rngDeckRoot = audit.deckRoot;
        table.rngPhase = audit.phase;
      }
      break;
    }
    case 'RNG_VOIDED':
      table.rngPhase = 'VOIDED';
      break;
    case 'STREET_ADVANCED':
      table.street = payload.street;
      table.board = payload.board;
      break;
    case 'HAND_STARTED':
      table.handId = payload.handId;
      table.handNumber = payload.handNumber;
      table.buttonSeat = payload.buttonSeat;
      table.street = 'PREFLOP';
      table.board = [];
      table.rngCommitment = null;
      table.rngDeckRoot = null;
      table.rngPhase = 'NONE';
      actionRequests.delete(tableId);
      revealedPositions.delete(tableId);
      break;
    case 'SEAT_CHANGED': {
      const seat = table.seats.find((s) => s.seat === payload.seat);
      if (seat) {
        seat.status = payload.status;
        seat.stack = payload.stack;
      }
      break;
    }
    case 'ACTION_REQUIRED': {
      const request = payload.request;
      if (request) {
        actionRequests.set(tableId, request);
        table.toActSeat = request.seat;
        table.actionDeadlineTs = request.deadlineTs;
      }
      break;
    }
    case 'ACTION_TAKEN': {
      const record = payload.record;
      if (record && record.seat !== undefined) {
        table.toActSeat = null;
        table.actionDeadlineTs = null;
        const seat = table.seats.find((s) => s.seat === record.seat);
        if (seat && record.potAfter) table.totalPot = record.potAfter;
      }
      break;
    }
    case 'HAND_COMPLETE':
      actionRequests.delete(tableId);
      table.toActSeat = null;
      table.actionDeadlineTs = null;
      if (payload.result) emitHand(summarizeHandResult(payload.result), payload.result);
      break;
    default:
      break;
  }
}

/**
 * Builds a `HandSummary`-shaped row from a `HAND_COMPLETE` delta.
 *
 * A live delta does not carry the RNG commitment for the hand that just ended
 * (the authoritative record arrives with `RNG_AUDITED` / `/api/v1/hands`), so
 * `commitment` is empty, `deckRoot` is `null`, `audited` is `false` and the
 * block numbers are `null`; those rows are flagged `fromLive: true` and pages
 * replace them with the authoritative `/api/v1/hands` entry on their next
 * refresh.
 *
 * @param {HandResult} result
 * @returns {HandSummary}
 */
export function summarizeHandResult(result) {
  /** @type {{seat: number, name: string|null, amount: string}[]} */
  const winners = [];
  for (const pot of result.pots ?? []) {
    for (const winner of pot.winners ?? []) {
      const seat = (result.seats ?? []).find((s) => s.seat === winner.seat);
      winners.push({
        seat: winner.seat,
        name: seat?.agentId ? agentName(seat.agentId) : null,
        amount: winner.amount,
      });
    }
  }
  const table = getTable(result.tableId);
  return {
    handId: result.handId,
    tableId: result.tableId,
    tableName: table?.name ?? result.tableId,
    handNumber: result.handNumber,
    mode: result.mode,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    streetReached: result.streetReached,
    board: result.board ?? [],
    totalPot: result.totalPot,
    totalRake: result.totalRake,
    playerCount: (result.seats ?? []).filter((s) => s.agentId !== null).length,
    winners,
    commitment: '',
    commitBlock: null,
    anchorBlock: null,
    proofVerified: false,
    deckRoot: null,
    audited: false,
    fromLive: true,
    // Carried so a money render site can ask the *table* how many decimals its
    // amounts have (whole play chips on a free table, the settlement token's on a
    // wager table) without a second fetch. `HandSummary.config` is optional on
    // the wire; a row built from a live delta is the one place it is free.
    config: table?.config ?? null,
  };
}

// ---------------------------------------------------------------------------
// REST bootstrap + polling fallback
// ---------------------------------------------------------------------------

/**
 * One REST refresh of agents + tables. Also the health probe used while the
 * socket is down.
 *
 * @returns {Promise<void>}
 */
export async function refreshFromApi() {
  try {
    const [agents, tables] = await Promise.all([getAgents(), getTables()]);
    state.agents = Array.isArray(agents?.agents) ? agents.agents : [];
    state.tables = Array.isArray(tables?.tables) ? tables.tables : [];
    state.updatedAt = typeof agents?.updatedAt === 'number' ? agents.updatedAt : Date.now();
    state.snapshotLoaded = true;
    state.lastError = null;
    scheduleEmit();
  } catch (err) {
    // The socket stays authoritative while it is up; a transient REST failure
    // is recorded so the pages can mention it without blanking the view.
    state.lastError = err instanceof Error ? err.message : String(err);
    scheduleEmit();
  }
}

function startPolling() {
  if (pollTimer !== null) return;
  void refreshFromApi();
  pollTimer = window.setInterval(() => {
    if (state.connection === 'LIVE') return;
    void refreshFromApi();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connect() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) return;
  /** @type {WebSocket} */
  let next;
  try {
    next = new WebSocket(monitorSocketUrl());
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    scheduleReconnect();
    return;
  }
  socket = next;
  next.addEventListener('open', onOpen);
  next.addEventListener('message', onMessage);
  next.addEventListener('close', onClose);
  next.addEventListener('error', onError);
}

function onOpen() {
  state.reconnectAttempts = 0;
  state.lastError = null;
  lastMessageAt = Date.now();
  setConnection('LIVE', 0);
  stopPolling();
  startPing();
  send({ type: 'PING' });
}

/**
 * @param {MessageEvent} event
 * @returns {void}
 */
function onMessage(event) {
  lastMessageAt = Date.now();
  let message;
  try {
    message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
  } catch {
    state.lastError = 'Received a non-JSON frame on the monitor socket';
    scheduleEmit();
    return;
  }
  handleMessage(message);
}

/**
 * @param {ServerMessage} message
 * @returns {void}
 */
function handleMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'WELCOME':
      state.serverTime = message.serverTime ?? null;
      state.chainId = message.chainId ?? null;
      state.version = message.version ?? null;
      setChromeInfo({ chainId: state.chainId, version: state.version });
      break;
    case 'MONITOR_SNAPSHOT':
      state.agents = Array.isArray(message.agents) ? message.agents : state.agents;
      state.tables = Array.isArray(message.tables) ? message.tables : state.tables;
      state.serverTime = message.serverTime ?? state.serverTime;
      state.snapshotLoaded = true;
      state.updatedAt = message.serverTime ?? Date.now();
      break;
    case 'MONITOR_EVENT':
      if (message.event) applyMonitorEvent(message.event);
      break;
    case 'PONG':
      state.serverTime = message.serverTime ?? state.serverTime;
      state.latencyMs = pingSentAt > 0 ? Date.now() - pingSentAt : null;
      break;
    case 'AGENT_STATUS':
      if (message.agent) upsertAgent(message.agent);
      break;
    case 'TABLE_STATE':
      if (message.table) upsertTable(message.table);
      break;
    case 'ERROR':
      state.lastError = message.message ?? 'Monitor feed error';
      break;
    default:
      break;
  }
  scheduleEmit();
}

function onClose() {
  socket = null;
  stopPing();
  scheduleReconnect();
}

function onError() {
  /* the close event that follows carries the recovery path */
}

/**
 * @param {any} payload
 * @returns {void}
 */
function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
  }
}

function startPing() {
  stopPing();
  pingTimer = window.setInterval(() => {
    pingSentAt = Date.now();
    send({ type: 'PING' });
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer !== null) window.clearInterval(pingTimer);
  pingTimer = null;
}

function scheduleReconnect() {
  const attempts = state.reconnectAttempts + 1;
  const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (attempts - 1));
  const delay = backoff + Math.floor(Math.random() * 250);
  setConnection(attempts >= OFFLINE_AFTER_ATTEMPTS ? 'OFFLINE' : 'RECONNECTING', attempts);
  startPolling();
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * A socket can stay `OPEN` while the server is gone. If nothing — not even a
 * `PONG` — arrives for `SOCKET_SILENCE_TIMEOUT_MS`, force a reconnect so the
 * monitor cannot silently go stale.
 */
function checkSocketHealth() {
  if (state.connection === 'LIVE' && Date.now() - lastMessageAt > SOCKET_SILENCE_TIMEOUT_MS) {
    state.lastError = 'No frames from the monitor socket — reconnecting';
    if (socket) {
      const stale = socket;
      socket = null;
      try {
        stale.close();
      } catch {
        /* ignore */
      }
    }
    scheduleReconnect();
  }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible' && state.connection !== 'LIVE' && started) {
    reconnectNow();
  }
}

function onNetworkOnline() {
  if (started) reconnectNow();
}

function onNetworkOffline() {
  setConnection('OFFLINE');
}

/** Drops the current socket and retries immediately (used on `online`/focus). */
export function reconnectNow() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    const current = socket;
    socket = null;
    try {
      current.close();
    } catch {
      /* ignore */
    }
  }
  state.reconnectAttempts = 0;
  setConnection('RECONNECTING', 0);
  connect();
}
