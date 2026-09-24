/**
 * `/stake` — the staking page.
 *
 * Wallet flow only, in four explicit steps:
 *  1. connect an EIP-1193 wallet (`wallet.js`) — a rejection is a normal state,
 *     never a thrown error;
 *  2. read `/api/v1/health` for the chain + contract addresses, `/api/v1/gate`
 *     for the LLMPOKER balance and `/api/v1/staking/summary` for the position;
 *  3. for every action (approve / stake / unstake / cancel / claim) ask
 *     `/api/v1/staking/tx` for a **pre-encoded** transaction and pass
 *     `to`/`data`/`value` to the wallet unchanged — this module never assembles
 *     calldata, and refuses anything that does not point at a published contract;
 *  4. poll for the receipt and report pending / success / failure with an
 *     explorer link when `chain.explorerUrl` is set.
 *
 * When `contracts.staking` (or `contracts.token`) is `null` — the expected state
 * today — the page says "staking opens when the token launches", disables every
 * action, and shows no spinner and no fake address. A `503` from the staking
 * endpoints renders the same peaceful state.
 *
 * Money rule: chip amounts are decimal strings handled with `BigInt` end to end
 * (`parseTokenInput`, `parseChips`, `minimumToChips`); `Number()` is never
 * applied to an amount.
 */

import { getGate, getHealth, getStakingSummary, getStakingTx, isNotConfigured } from '../api.js';
import { CHIP_DECIMALS } from '../constants.js';
import {
  formatInt,
  formatMinimumTokens,
  minimumToChips,
  parseChips,
  parseTokenInput,
  toTimestampMs,
  formatCountdown,
} from '../format.js';
import {
  badge,
  clearNode,
  errorBanner,
  h,
  moneyEl,
  renderChrome,
  requireElement,
  safeExternalUrl,
  setExpectedChainId,
  setText,
  showBanner,
  startClock,
} from '../ui.js';
import {
  connect,
  ensureChain,
  isAddress,
  readNativeBalance,
  sendTransaction,
  shortAddress,
  subscribeWallet,
  waitForReceipt,
  walletState,
} from '../wallet.js';

/** @typedef {import('../types.js').GateResponse} GateResponse */
/** @typedef {import('../types.js').HealthResponse} HealthResponse */
/** @typedef {import('../types.js').StakingAction} StakingAction */
/** @typedef {import('../types.js').StakingSummary} StakingSummary */

/** Human labels for the five actions. */
/** @type {Record<StakingAction, string>} */
const ACTION_LABEL = {
  approve: 'Approve LLMPOKER',
  stake: 'Stake',
  unstake: 'Request unstake',
  cancel: 'Cancel unstake',
  claim: 'Claim rewards',
};

/** Actions whose `/api/v1/staking/tx` request carries an `amount`. */
/** @type {StakingAction[]} */
const AMOUNT_ACTIONS = ['approve', 'stake', 'unstake'];

/**
 * @typedef {Object} TxLogEntry
 * @property {StakingAction} action
 * @property {string|null} hash
 * @property {'pending'|'success'|'failed'|'error'} state
 * @property {string} message
 * @property {number} at
 */

/**
 * Mount points, resolved from the static skeleton in `stake.html`.
 * @type {{
 *   banner: HTMLElement, walletBody: HTMLElement, walletStatus: HTMLElement,
 *   poolBody: HTMLElement, txStatus: HTMLElement, txLog: HTMLElement,
 *   stakeForm: HTMLFormElement, unstakeForm: HTMLFormElement,
 *   stakeAmount: HTMLInputElement, unstakeAmount: HTMLInputElement,
 *   approveButton: HTMLButtonElement, stakeButton: HTMLButtonElement,
 *   unstakeButton: HTMLButtonElement, cancelButton: HTMLButtonElement,
 *   claimButton: HTMLButtonElement,
 * }}
 */
const dom = {
  banner: requireElement('page-banner'),
  walletBody: requireElement('wallet-body'),
  walletStatus: requireElement('wallet-panel-status'),
  poolBody: requireElement('pool-body'),
  txStatus: requireElement('tx-status'),
  txLog: requireElement('tx-log'),
  stakeForm: requireForm('stake-form'),
  unstakeForm: requireForm('unstake-form'),
  stakeAmount: requireInput('stake-amount'),
  unstakeAmount: requireInput('unstake-amount'),
  approveButton: requireButton('approve-button'),
  stakeButton: requireButton('stake-button'),
  unstakeButton: requireButton('unstake-button'),
  cancelButton: requireButton('cancel-button'),
  claimButton: requireButton('claim-button'),
};

const view = {
  /** @type {HealthResponse|null} */
  health: null,
  /** @type {Error|null} */
  healthError: null,
  /** @type {GateResponse|null} */
  gate: null,
  /** @type {Error|null} */
  gateError: null,
  /** @type {StakingSummary|null} */
  summary: null,
  /** @type {Error|null} */
  summaryError: null,
  /** @type {string|null} */
  nativeBalance: null,
  /** @type {boolean} */
  nativeRead: false,
  /** @type {StakingAction|null} */
  busy: null,
  /** @type {boolean} */
  switching: false,
  /** @type {string|null} */
  walletAddress: null,
  /** @type {TxLogEntry[]} */
  txs: [],
};

function main() {
  renderChrome('/stake');
  bindActions();
  renderWallet();
  renderPool();
  renderActions();
  renderTxs();

  subscribeWallet(onWalletChanged);
  onWalletChanged();
  startClock();

  void loadHealth();
  window.setInterval(() => void loadHealth(), 20000);
}

/**
 * @param {string} id
 * @returns {HTMLFormElement}
 */
function requireForm(id) {
  const node = requireElement(id);
  if (!(node instanceof HTMLFormElement)) throw new Error(`stake page skeleton: #${id} is not a form`);
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
function requireInput(id) {
  const node = requireElement(id);
  if (!(node instanceof HTMLInputElement)) throw new Error(`stake page skeleton: #${id} is not an input`);
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
function requireButton(id) {
  const node = requireElement(id);
  if (!(node instanceof HTMLButtonElement)) throw new Error(`stake page skeleton: #${id} is not a button`);
  return node;
}

function bindActions() {
  dom.approveButton.addEventListener('click', () => void runAction('approve'));
  dom.stakeButton.addEventListener('click', () => void runAction('stake'));
  dom.unstakeButton.addEventListener('click', () => void runAction('unstake'));
  dom.cancelButton.addEventListener('click', () => void runAction('cancel'));
  dom.claimButton.addEventListener('click', () => void runAction('claim'));
  // A form submit (pressing Enter in the amount field) maps to the primary
  // action of that block; it still needs the button's own click to sign.
  dom.stakeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void runAction('stake');
  });
  dom.unstakeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void runAction('unstake');
  });
}

// ---------------------------------------------------------------------------
// Configuration derived from /api/v1/health
// ---------------------------------------------------------------------------

async function loadHealth() {
  try {
    const health = await getHealth();
    view.health = health;
    view.healthError = null;
    // The header's wrong-network note follows the chain the server reports.
    setExpectedChainId(health.chain?.chainId ?? health.chainId);
    showBanner(dom.banner, null);
  } catch (err) {
    view.healthError = /** @type {Error} */ (err);
    showBanner(dom.banner, errorBanner(err, 'the platform health endpoint (/api/v1/health)'));
  }
  renderWallet();
  renderPool();
  renderActions();
}

/** @returns {import('../types.js').ChainMetadata|null} */
function chainMeta() {
  return view.health?.chain ?? null;
}

/** @returns {string|null} the Staking.sol address, or `null` when not published */
function stakingAddress() {
  const value = view.health?.contracts?.staking ?? null;
  return isAddress(value) ? value : null;
}

/** @returns {string|null} the LLMPOKER address, or `null` when not published */
function tokenAddress() {
  const value = view.health?.contracts?.token ?? null;
  return isAddress(value) ? value : null;
}

/** @returns {boolean} */
function configured() {
  return stakingAddress() !== null && tokenAddress() !== null;
}

/** @returns {number} */
function tokenDecimals() {
  const fromGate = view.gate?.decimals;
  if (typeof fromGate === 'number' && Number.isInteger(fromGate) && fromGate >= 0 && fromGate <= 36) return fromGate;
  const value = view.health?.tokenomics?.tokenDecimals;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36) return value;
  return CHIP_DECIMALS;
}

/** @returns {string} */
function tokenSymbol() {
  const value = view.gate?.symbol ?? view.health?.tokenomics?.tokenSymbol;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'LLMPOKER';
}

/** @returns {boolean} true when the wallet is on the chain /api/v1/health publishes */
function onRightChain() {
  const chain = chainMeta();
  if (!chain) return false;
  return walletState.chainId === chain.chainId;
}

// ---------------------------------------------------------------------------
// Wallet state
// ---------------------------------------------------------------------------

function onWalletChanged() {
  const address = walletState.connected && walletState.address ? walletState.address : null;
  if (address !== view.walletAddress) {
    view.walletAddress = address;
    view.gate = null;
    view.gateError = null;
    view.summary = null;
    view.summaryError = null;
    view.nativeBalance = null;
    view.nativeRead = false;
    if (address) void refreshPosition();
  }
  renderWallet();
  renderPool();
  renderActions();
}

/**
 * Reads the gate balance, the staking summary and the native balance in
 * parallel; each failure is recorded separately so one unhappy endpoint does not
 * blank the others.
 *
 * @returns {Promise<void>}
 */
async function refreshPosition() {
  const address = view.walletAddress;
  if (!address) return;
  await Promise.all([loadGate(address), loadSummary(address), loadNative(address)]);
  renderWallet();
  renderPool();
  renderActions();
}

/**
 * @param {string} address
 * @returns {Promise<void>}
 */
async function loadGate(address) {
  try {
    view.gate = await getGate(address);
    view.gateError = null;
  } catch (err) {
    view.gate = null;
    view.gateError = /** @type {Error} */ (err);
  }
}

/**
 * @param {string} address
 * @returns {Promise<void>}
 */
async function loadSummary(address) {
  try {
    view.summary = await getStakingSummary(address);
    view.summaryError = null;
  } catch (err) {
    view.summary = null;
    view.summaryError = /** @type {Error} */ (err);
  }
}

/**
 * @param {string} address
 * @returns {Promise<void>}
 */
async function loadNative(address) {
  view.nativeBalance = await readNativeBalance(address);
  view.nativeRead = true;
}

/**
 * `connect()` never throws; a rejection lands in `walletState.error`.
 *
 * @returns {Promise<void>}
 */
async function connectHere() {
  const result = await connect();
  if (result) {
    setWalletStatus(`Connected ${result.address}${result.chainId === null ? '' : ` on chain ${result.chainId}`}.`, 'success');
  } else {
    setWalletStatus(walletState.error ?? 'Wallet not connected.', 'error');
  }
}

/**
 * @returns {Promise<void>}
 */
async function switchChainHere() {
  const chain = chainMeta();
  if (!chain) return;
  view.switching = true;
  renderWallet();
  try {
    await ensureChain(chain);
    setWalletStatus(`Wallet switched to ${chain.name} (chain id ${chain.chainId}).`, 'success');
    await refreshPosition();
  } catch (err) {
    setWalletStatus(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    view.switching = false;
    renderWallet();
    renderActions();
  }
}

/**
 * @param {string} message
 * @param {'idle'|'pending'|'success'|'error'} state
 * @returns {void}
 */
function setWalletStatus(message, state) {
  setText(dom.walletStatus, message);
  dom.walletStatus.dataset.state = state;
  dom.walletStatus.className = state === 'error' ? 'note warn-text' : state === 'success' ? 'note' : 'note muted';
}

// ---------------------------------------------------------------------------
// Wallet panel
// ---------------------------------------------------------------------------

function renderWallet() {
  clearNode(dom.walletBody);
  const address = view.walletAddress;

  if (!address) {
    if (!walletState.available) {
      dom.walletBody.appendChild(
        h(
          'div',
          { class: 'banner banner-warning', role: 'status' },
          h('p', { class: 'banner-title', text: 'No browser wallet detected' }),
          h('p', {
            class: 'banner-message',
            text:
              'Install an EIP-1193 wallet (for example MetaMask) and reload to stake. Everything on this page except ' +
              'the action buttons works without a wallet: the pool is read from the API.',
          }),
        ),
      );
      return;
    }
    dom.walletBody.appendChild(
      h(
        'div',
        { class: 'gate-line' },
        h('button', {
          class: 'button button-primary',
          type: 'button',
          disabled: walletState.connecting,
          text: walletState.connecting ? 'Connecting…' : 'Connect wallet',
          onclick: () => void connectHere(),
        }),
        h('span', {
          class: 'muted small',
          text: 'Connecting shares your public address only. This site never sees a key, and every signature is requested from your wallet after a click.',
        }),
      ),
    );
    return;
  }

  const chain = chainMeta();
  const native = chain?.nativeCurrency ?? null;
  const nativeDecimals = typeof native?.decimals === 'number' ? native.decimals : CHIP_DECIMALS;
  const rightChain = onRightChain();
  const symbol = tokenSymbol();

  dom.walletBody.appendChild(
    h(
      'dl',
      { class: 'kv-inline wide' },
      h('dt', { text: 'address' }),
      h('dd', null, h('code', { class: 'hash', title: address, text: address })),
      h('dt', { text: 'network' }),
      h(
        'dd',
        { class: 'gate-line' },
        chain
          ? h('span', {
              text: `${chain.name} (chain id ${chain.chainId})`,
            })
          : h('span', { class: 'muted', text: 'chain unknown — /api/v1/health has not answered' }),
        ' ',
        walletState.chainId === null
          ? badge('chain unknown', 'muted', 'the wallet did not report a chain id')
          : rightChain
            ? badge(`wallet on ${walletState.chainId}`, 'verified', 'the wallet is on the settlement chain')
            : badge(`wallet on ${walletState.chainId}`, 'failed', 'wrong network — transactions are disabled'),
      ),
      h('dt', { text: `native balance (${native?.symbol ?? 'native'})` }),
      h(
        'dd',
        null,
        !view.nativeRead
          ? h('span', { class: 'muted', text: 'reading…' })
          : view.nativeBalance === null
            ? h('span', { class: 'muted', text: 'unavailable — the wallet did not answer eth_getBalance' })
            : h(
                'span',
                null,
                moneyEl(view.nativeBalance, { decimals: nativeDecimals, maxFractionDigits: 6 }),
                ` ${native?.symbol ?? ''}`,
              ),
      ),
      h('dt', { text: `${symbol} balance` }),
      h(
        'dd',
        null,
        gateBalanceNode(symbol),
      ),
      h('dt', { text: 'free-table eligibility' }),
      h('dd', null, gateEligibilityNode()),
    ),
  );

  if (!rightChain && chain) {
    dom.walletBody.appendChild(
      h(
        'div',
        { class: 'gate-line' },
        h('button', {
          class: 'button',
          type: 'button',
          disabled: view.switching,
          text: view.switching ? 'Asking your wallet…' : `Switch to ${chain.name}`,
          onclick: () => void switchChainHere(),
        }),
        h('span', {
          class: 'muted small',
          text: chain.rpcUrl
            ? 'Your wallet will be asked to switch, and to add the network if it has never seen it.'
            : 'The API does not publish a public RPC URL yet, so this site cannot add the network for you — add it in your wallet manually if the switch fails.',
        }),
      ),
    );
  }
}

/**
 * @param {string} symbol
 * @returns {HTMLElement|string}
 */
function gateBalanceNode(symbol) {
  if (view.gateError) {
    return isNotConfigured(view.gateError)
      ? h('span', { class: 'muted', text: `${symbol} is not deployed yet — no balance to read (/api/v1/gate answers 503).` })
      : h('span', { class: 'warn-text', text: `unavailable: ${view.gateError.message}` });
  }
  if (!view.gate) return h('span', { class: 'muted', text: 'reading…' });
  return h(
    'span',
    null,
    moneyEl(view.gate.balance, { decimals: view.gate.decimals, maxFractionDigits: 4 }),
    ` ${view.gate.symbol ?? symbol}`,
  );
}

/** @returns {HTMLElement|string} */
function gateEligibilityNode() {
  if (!view.gate) return h('span', { class: 'muted', text: view.gateError ? 'unknown' : 'reading…' });
  if (view.gate.enabled !== true) {
    return h('span', {
      class: 'muted',
      text: 'not enforced — the free-table gate is disabled on this deployment, so anyone may sit down',
    });
  }
  if (view.gate.eligible === true) {
    return badge('eligible', 'verified', 'the wallet holds at least the free-play minimum');
  }
  if (view.gate.eligible === false) {
    return badge('below the minimum', 'warn', 'the wallet holds less than the free-play minimum');
  }
  // eligible: null with enabled: true should not happen; saying "not determined"
  // is the honest answer instead of inventing a verdict.
  return h('span', { class: 'muted', text: 'not determined by the API (eligible: null)' });
}

// ---------------------------------------------------------------------------
// Pool panel
// ---------------------------------------------------------------------------

function renderPool() {
  clearNode(dom.poolBody);
  const health = view.health;
  const symbol = tokenSymbol();
  const decimals = tokenDecimals();

  if (!health) {
    dom.poolBody.appendChild(
      h('p', {
        class: 'muted',
        text: view.healthError
          ? 'The pool cannot be described while /api/v1/health is unreachable.'
          : 'Reading /api/v1/health…',
      }),
    );
    return;
  }

  if (!configured()) {
    const staking = health.contracts?.staking ?? null;
    const token = health.contracts?.token ?? null;
    dom.poolBody.appendChild(
      infoBox(
        'Staking opens when the token launches',
        `contracts.staking is ${staking === null ? 'null' : String(staking)} and contracts.token is ` +
          `${token === null ? 'null' : String(token)} in /api/v1/health, so there is no pool address to stake into. ` +
          'While that is true /api/v1/staking/summary and /api/v1/staking/tx answer 503, the buttons below stay ' +
          'disabled, and this page will not show a placeholder address or spin forever. Reading the tables, the ' +
          'hands and the shuffle proofs on this site needs no token at all.',
      ),
    );
    dom.poolBody.appendChild(
      h(
        'dl',
        { class: 'kv-inline wide' },
        h('dt', { text: 'token' }),
        h('dd', null, h('code', { text: symbol }), ` · ${formatInt(decimals)} decimals`),
        h('dt', { text: 'minimum stake' }),
        h('dd', { class: 'muted', text: 'not published until Staking.sol is deployed' }),
        h('dt', { text: 'cooldown' }),
        h('dd', { class: 'muted', text: 'not published until Staking.sol is deployed' }),
        h('dt', { text: 'pool total' }),
        h('dd', { class: 'muted', text: 'not published until Staking.sol is deployed' }),
      ),
    );
    return;
  }

  if (!view.walletAddress) {
    dom.poolBody.appendChild(
      h('p', {
        class: 'muted',
        text: 'Connect a wallet to read your position (and the pool total): /api/v1/staking/summary is per wallet.',
      }),
    );
    return;
  }

  if (view.summaryError) {
    dom.poolBody.appendChild(
      isNotConfigured(view.summaryError)
        ? infoBox(
            'The pool is not usable right now',
            '/api/v1/staking/summary answered 503 even though /api/v1/health publishes a staking address — the ' +
              'deployment is not configured for staking. Nothing was signed and nothing is pending.',
          )
        : errorBanner(view.summaryError, 'your staking position (/api/v1/staking/summary)'),
    );
    return;
  }

  const summary = view.summary;
  if (!summary) {
    dom.poolBody.appendChild(h('p', { class: 'muted', text: 'Reading /api/v1/staking/summary…' }));
    return;
  }

  const symbolOut = summary.symbol ?? symbol;
  const rewardSymbol = summary.rewardSymbol ?? symbol;
  const summaryDecimals = typeof summary.decimals === 'number' ? summary.decimals : decimals;
  const minStakeChips = minimumToChips(summary.minStake ?? null, summaryDecimals);
  const cooldownSeconds = typeof summary.cooldownSeconds === 'number' ? summary.cooldownSeconds : null;

  dom.poolBody.appendChild(
    h(
      'dl',
      { class: 'kv-inline wide' },
      h('dt', { text: 'staked' }),
      h('dd', null, moneyEl(summary.staked, { decimals: summaryDecimals, maxFractionDigits: 6 }), ` ${symbolOut}`),
      h('dt', { text: 'pending rewards' }),
      h('dd', null, moneyEl(summary.pendingRewards, { decimals: summaryDecimals, maxFractionDigits: 6 }), ` ${rewardSymbol}`),
      h('dt', { text: 'cooldown' }),
      h('dd', null, cooldownNode(summary, summaryDecimals, symbolOut, cooldownSeconds)),
      h('dt', { text: 'pool total staked' }),
      h('dd', null, moneyEl(summary.totalStaked, { decimals: summaryDecimals, maxFractionDigits: 6 }), ` ${symbolOut}`),
      h('dt', { text: 'minimum stake' }),
      h(
        'dd',
        null,
        summary.minStake === null || summary.minStake === undefined
          ? h('span', { class: 'muted', text: 'not reported' })
          : h(
              'span',
              { title: `raw: ${String(summary.minStake)}` },
              h('strong', { text: formatMinimumTokens(summary.minStake, summaryDecimals) }),
              ` ${symbolOut}`,
            ),
      ),
      h('dt', { text: 'unstake cooldown' }),
      h('dd', { text: cooldownSeconds === null ? '—' : `${formatInt(cooldownSeconds)}s` }),
      h('dt', { text: 'staking contract' }),
      h('dd', null, h('code', { class: 'hash', title: stakingAddress() ?? '', text: shortAddress(stakingAddress()) })),
      h('dt', { text: 'reward token' }),
      h(
        'dd',
        null,
        summary.rewardToken && isAddress(summary.rewardToken)
          ? h('code', { class: 'hash', title: summary.rewardToken, text: shortAddress(summary.rewardToken) })
          : h('span', { class: 'muted', text: `${rewardSymbol} (no separate reward token address reported)` }),
      ),
    ),
  );

  if (minStakeChips !== null) {
    dom.poolBody.appendChild(
      h('p', {
        class: 'note',
        text: `Amounts are entered in ${symbolOut}; the page converts them with BigInt and never rounds them. The minimum stake is ${formatMinimumTokens(summary.minStake, summaryDecimals)} ${symbolOut}.`,
      }),
    );
  }
}

/**
 * @param {StakingSummary} summary
 * @param {number} decimals
 * @param {string} symbol
 * @param {number|null} cooldownSeconds
 * @returns {HTMLElement}
 */
function cooldownNode(summary, decimals, symbol, cooldownSeconds) {
  const cooldown = summary.cooldown;
  if (!cooldown) {
    return h('span', {
      class: 'muted',
      text:
        cooldownSeconds === null
          ? 'no unstake request pending'
          : `no unstake request pending (unstaking has a ${formatInt(cooldownSeconds)}s cooldown)`,
    });
  }
  const unlockAt = toTimestampMs(cooldown.unlockAt);
  const remaining = unlockAt === null ? null : unlockAt - Date.now();
  // The server's own `claimable` verdict wins over a local clock comparison.
  const claimable = typeof cooldown.claimable === 'boolean' ? cooldown.claimable : remaining !== null && remaining <= 0;
  return h(
    'span',
    { class: 'gate-line' },
    moneyEl(cooldown.amount, { decimals, maxFractionDigits: 6 }),
    ` ${symbol}`,
    unlockAt === null
      ? badge('unlock time not reported', 'muted', 'cooldown.unlockAt was not a usable timestamp')
      : claimable
        ? badge('cooldown expired — ready to claim', 'verified', 'the unstake request can be claimed now')
        : h(
            'span',
            null,
            badge('unlocking in', 'pending', 'time left on the unstake cooldown'),
            ' ',
            h('strong', { dataset: { deadline: String(unlockAt) }, text: formatCountdown(remaining ?? 0) }),
          ),
  );
}

/**
 * @param {string} title
 * @param {string} message
 * @returns {HTMLElement}
 */
function infoBox(title, message) {
  return h(
    'div',
    { class: 'banner banner-info', role: 'status' },
    h('p', { class: 'banner-title', text: title }),
    h('p', { class: 'banner-message', text: message }),
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * @returns {string} why the actions are disabled, or `''` when they are enabled
 */
function disabledReason() {
  if (!view.health) return 'waiting for /api/v1/health to describe this deployment';
  if (!configured()) return 'staking opens when the token launches — contracts.staking is null in /api/v1/health';
  if (!view.walletAddress) return 'connect a wallet first';
  if (!onRightChain()) {
    const chain = chainMeta();
    return `switch your wallet to ${chain ? `${chain.name} (chain id ${chain.chainId})` : 'the settlement chain'} first`;
  }
  if (view.busy !== null) return `${ACTION_LABEL[view.busy]} is already in progress`;
  return '';
}

function renderActions() {
  const reason = disabledReason();
  const ready = reason === '';
  const cooldownPending = view.summary?.cooldown !== null && view.summary?.cooldown !== undefined;

  setDisabled(dom.approveButton, !ready, reason);
  setDisabled(dom.stakeButton, !ready, reason);
  setDisabled(dom.unstakeButton, !ready, reason);
  setDisabled(dom.claimButton, !ready, reason);
  setDisabled(
    dom.cancelButton,
    !ready || !cooldownPending,
    cooldownPending ? reason : 'there is no pending unstake request to cancel',
  );

  dom.stakeAmount.disabled = !ready;
  dom.unstakeAmount.disabled = !ready;
}

/**
 * @param {HTMLButtonElement} button
 * @param {boolean} disabled
 * @param {string} title
 * @returns {void}
 */
function setDisabled(button, disabled, title) {
  button.disabled = disabled;
  if (title !== '') button.title = title;
  else button.removeAttribute('title');
}

/**
 * @param {StakingAction} action
 * @returns {HTMLInputElement|null} the amount field for `action`
 */
function amountInput(action) {
  if (action === 'unstake') return dom.unstakeAmount;
  if (action === 'approve' || action === 'stake') return dom.stakeAmount;
  return null;
}

/**
 * The whole flow for one action. Nothing leaves this page before the user's own
 * click, and nothing is signed before the wallet's own confirmation prompt.
 *
 * @param {StakingAction} action
 * @returns {Promise<void>}
 */
async function runAction(action) {
  if (view.busy !== null) {
    setTxStatus(`${ACTION_LABEL[view.busy]} is already in progress — finish or reject that one first.`, 'error');
    return;
  }
  const reason = disabledReason();
  if (reason !== '') {
    setTxStatus(`Cannot ${ACTION_LABEL[action].toLowerCase()}: ${reason}.`, 'error');
    renderActions();
    return;
  }
  const address = view.walletAddress;
  if (!address) return;

  const decimals = tokenDecimals();
  const symbol = tokenSymbol();
  /** @type {bigint|null} */
  let amount = null;

  if (AMOUNT_ACTIONS.includes(action)) {
    const input = amountInput(action);
    const message = input ? input.value : '';
    amount = parseTokenInput(message, decimals);
    if (amount === null) {
      setTxStatus(`Enter the amount in ${symbol} first — digits and one decimal point only (for example 1500.25).`, 'error');
      return;
    }
    if (amount <= 0n) {
      setTxStatus(`The ${symbol} amount must be greater than zero.`, 'error');
      return;
    }
    const tooBig = amountProblem(action, amount, decimals, symbol);
    if (tooBig !== null) {
      setTxStatus(tooBig, 'error');
      return;
    }
  }

  view.busy = action;
  renderActions();
  setTxStatus(`${ACTION_LABEL[action]}: asking /api/v1/staking/tx for the transaction…`, 'pending');

  /** @type {import('../types.js').StakingTxResponse} */
  let tx;
  try {
    tx = await getStakingTx(address, action, amount === null ? undefined : amount.toString());
  } catch (err) {
    view.busy = null;
    renderActions();
    if (isNotConfigured(err)) {
      setTxStatus(
        'Staking is not configured on this deployment (/api/v1/staking/tx answered 503). Nothing was sent and no wallet prompt was opened.',
        'error',
      );
      pushTx({ action, hash: null, state: 'error', message: 'not configured (503)', at: Date.now() });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      setTxStatus(`The transaction could not be prepared: ${message}`, 'error');
      pushTx({ action, hash: null, state: 'error', message, at: Date.now() });
    }
    void loadHealth();
    return;
  }

  const refusal = validateTx(tx, action);
  if (refusal !== null) {
    view.busy = null;
    renderActions();
    setTxStatus(refusal, 'error');
    pushTx({ action, hash: null, state: 'error', message: refusal, at: Date.now() });
    return;
  }

  setTxStatus(`${ACTION_LABEL[action]}: confirm the transaction in your wallet — ${tx.summary ?? action}.`, 'pending');
  /** @type {string} */
  let hash;
  try {
    hash = await sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  } catch (err) {
    view.busy = null;
    renderActions();
    const message = err instanceof Error ? err.message : String(err);
    setTxStatus(`${ACTION_LABEL[action]} was not sent: ${message}`, 'error');
    pushTx({ action, hash: null, state: 'error', message, at: Date.now() });
    return;
  }

  pushTx({ action, hash, state: 'pending', message: 'submitted — waiting for a receipt', at: Date.now() });
  setTxStatus(`${ACTION_LABEL[action]} submitted as ${hash}. Waiting for a receipt…`, 'pending');

  const receipt = await waitForReceipt(hash);
  view.busy = null;
  renderActions();

  if (receipt === null) {
    updateTx(hash, 'pending', 'no receipt yet — the transaction is still pending; check your wallet or the explorer');
    setTxStatus(
      `${ACTION_LABEL[action]} was submitted as ${hash} but no receipt arrived within the timeout — it may still confirm. ` +
        'The position below is refreshed from the API.',
      'pending',
    );
  } else if (receipt.status === '0x1') {
    updateTx(hash, 'success', 'confirmed (status 0x1)');
    setTxStatus(`${ACTION_LABEL[action]} confirmed: ${hash}.`, 'success');
  } else {
    updateTx(hash, 'failed', `reverted (status ${receipt.status ?? 'unknown'})`);
    setTxStatus(
      `${ACTION_LABEL[action]} was mined but reverted (status ${receipt.status ?? 'unknown'}): ${hash}. Nothing changed on-chain.`,
      'error',
    );
  }

  void refreshPosition();
  void loadHealth();
}

/**
 * Extra, non-contract-inventing sanity checks on the amount, using only values
 * the API itself reported.
 *
 * @param {StakingAction} action
 * @param {bigint} amount
 * @param {number} decimals
 * @param {string} symbol
 * @returns {string|null} a message when the amount is not acceptable
 */
function amountProblem(action, amount, decimals, symbol) {
  if (action === 'stake' && view.summary) {
    const min = minimumToChips(view.summary.minStake ?? null, decimals);
    if (min !== null && amount < min) {
      return `The pool's minimum stake is ${formatMinimumTokens(view.summary.minStake, decimals)} ${symbol}.`;
    }
  }
  if (action === 'stake' && view.gate) {
    const balance = parseChips(view.gate.balance);
    if (balance !== null && amount > balance) {
      return `You hold ${formatMinimumTokens(view.gate.balance, decimals)} ${symbol} — the amount is larger than your balance.`;
    }
  }
  if (action === 'unstake' && view.summary) {
    const staked = parseChips(view.summary.staked);
    if (staked !== null && amount > staked) {
      return `You have ${formatMinimumTokens(view.summary.staked, decimals)} ${symbol} staked — the amount is larger than that.`;
    }
  }
  return null;
}

/**
 * Refuses any transaction that does not target a contract `/api/v1/health`
 * publishes, or that is encoded for another chain.
 *
 * @param {import('../types.js').StakingTxResponse} tx
 * @param {StakingAction} action
 * @returns {string|null} a message when the transaction must not be sent
 */
function validateTx(tx, action) {
  if (!tx || typeof tx !== 'object') return 'The server returned no transaction — nothing was sent.';
  if (!isAddress(tx.to)) {
    return `The server returned an unusable contract address for ${action} — nothing was sent.`;
  }
  const chain = chainMeta();
  if (chain && typeof tx.chainId === 'number' && tx.chainId !== chain.chainId) {
    return `The transaction is encoded for chain ${tx.chainId} but /api/v1/health reports ${chain.chainId} — nothing was sent.`;
  }
  if (action !== 'approve' && stakingAddress() !== null && tx.to.toLowerCase() !== stakingAddress()?.toLowerCase()) {
    return `The server returned a ${action} transaction to ${tx.to}, which is not the published Staking.sol address — nothing was sent.`;
  }
  if (action === 'approve' && tokenAddress() !== null && tx.to.toLowerCase() !== tokenAddress()?.toLowerCase()) {
    return `The server returned an approve transaction to ${tx.to}, which is not the published LLMPOKER address — nothing was sent.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transaction log + status line
// ---------------------------------------------------------------------------

/**
 * @param {string} message
 * @param {'idle'|'pending'|'success'|'error'} state
 * @returns {void}
 */
function setTxStatus(message, state) {
  setText(dom.txStatus, message);
  dom.txStatus.dataset.state = state;
}

/**
 * @param {TxLogEntry} entry
 * @returns {void}
 */
function pushTx(entry) {
  view.txs = [entry, ...view.txs].slice(0, 12);
  renderTxs();
}

/**
 * @param {string} hash
 * @param {TxLogEntry['state']} state
 * @param {string} message
 * @returns {void}
 */
function updateTx(hash, state, message) {
  view.txs = view.txs.map((entry) => (entry.hash === hash ? { ...entry, state, message } : entry));
  renderTxs();
}

function renderTxs() {
  clearNode(dom.txLog);
  if (view.txs.length === 0) {
    dom.txLog.appendChild(h('li', { class: 'muted', text: 'Nothing requested yet in this session.' }));
    return;
  }
  for (const entry of view.txs) {
    const explorer = explorerTxUrl(entry.hash);
    dom.txLog.appendChild(
      h(
        'li',
        null,
        badge(ACTION_LABEL[entry.action], stateKind(entry.state)),
        h('span', { class: 'small', text: entry.message }),
        entry.hash === null
          ? null
          : h(
              'code',
              { class: 'hash small', title: entry.hash, text: shortAddress(entry.hash) },
            ),
        explorer === null
          ? entry.hash === null
            ? null
            : h('span', { class: 'muted small', text: 'no explorer published yet' })
          : h('a', { class: 'link small', href: explorer, rel: 'noreferrer noopener', text: 'view on explorer' }),
        h('span', { class: 'muted small', text: new Date(entry.at).toLocaleTimeString() }),
      ),
    );
  }
}

/**
 * @param {TxLogEntry['state']} state
 * @returns {string} a CSS badge suffix
 */
function stateKind(state) {
  if (state === 'success') return 'verified';
  if (state === 'failed' || state === 'error') return 'failed';
  if (state === 'pending') return 'pending';
  return 'muted';
}

/**
 * @param {string|null} hash
 * @returns {string|null} `chain.explorerUrl` + `/tx/<hash>`, when both exist
 */
function explorerTxUrl(hash) {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  const base = safeExternalUrl(chainMeta()?.explorerUrl ?? null);
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/tx/${hash}`;
}

main();
