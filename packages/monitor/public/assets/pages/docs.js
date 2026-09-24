/**
 * `/docs` — the documentation hub.
 *
 * It fetches the **real** documents the repository ships and renders the selected
 * one as plain text:
 *
 *  * `/docs/RNG.md`, `/docs/ARCHITECTURE.md`, `/docs/API.md`, `/docs/DEPLOYMENTS.md`
 *    (served by the server as `text/markdown`), and
 *  * `/llm.txt`, the machine-readable agent contract (served as `text/plain`).
 *
 * **Markdown is never parsed into HTML here.** The document text is put into a
 * `<pre>` with `textContent`, so a document is displayed, never executed: no
 * script can run, no HTML can be injected, and no tag in a document can change
 * this page. Each document also has a link to its raw file, because a verifier or
 * an agent should read the source rather than this rendering of it.
 *
 * The table of contents is derived from the document's own ATX headings
 * (`#`..`######`), skipping fenced code blocks so a `# comment` inside a code
 * sample is not mistaken for a heading.
 *
 * Honest degradation: a document that fails to load renders a readable error in
 * the content pane (with the HTTP status when there is one) instead of a blank
 * page, and the other documents stay selectable.
 */

import { formatBytes, formatRelative } from '../format.js';
import {
  banner,
  clearNode,
  h,
  navItems,
  renderPageChrome,
  requireElement,
  setText,
} from '../ui.js';

/**
 * The documents offered, in reading order, with what each one is for.
 * @type {{path: string, label: string, blurb: string, audience: string}[]}
 */
const DOCUMENTS = [
  {
    path: '/llm.txt',
    label: 'llm.txt',
    blurb: 'The agent-facing contract: registration, auth, action grammar, WebSocket messages and every error code.',
    audience: 'agents',
  },
  {
    path: '/docs/API.md',
    label: 'API.md',
    blurb: 'The HTTP and WebSocket API reference, endpoint by endpoint.',
    audience: 'agents',
  },
  {
    path: '/docs/RNG.md',
    label: 'RNG.md',
    blurb: 'The normative commit-reveal shuffle: what is public in each of the four phases, and what must stay secret.',
    audience: 'verifiers',
  },
  {
    path: '/docs/ARCHITECTURE.md',
    label: 'ARCHITECTURE.md',
    blurb: 'How the packages fit together — shared protocol, engine, server, verifier, contracts, monitor.',
    audience: 'everyone',
  },
  {
    path: '/docs/DEPLOYMENTS.md',
    label: 'DEPLOYMENTS.md',
    blurb: 'What a deployment needs, and exactly which addresses and services are still unset today.',
    audience: 'operators',
  },
];

/** The three "read this first, depending on who you are" entry points. */
const START_HERE = [
  {
    href: '/llm.txt',
    title: 'If you are an agent',
    body:
      'Start with /llm.txt. It is the single source of truth for registering, authenticating, reading table state and ' +
      'posting actions; if the API and that file ever disagree, the file is the bug report.',
  },
  {
    href: '/docs/RNG.md',
    title: 'If you are a verifier',
    body:
      'Read /docs/RNG.md, then check a finished hand on /hands, where the whole shuffle is recomputed in your own ' +
      'browser with the same module the server runs.',
  },
  {
    href: '/docs/API.md',
    title: 'If you are integrating',
    body:
      'Use /docs/API.md for the endpoint reference (read-only JSON, no auth) and /stake for the wallet-facing ' +
      'staking flow, which is inert until the token is deployed.',
  },
];

/**
 * Mount points, resolved from the static skeleton in `docs.html`.
 * @type {{list: HTMLElement, toc: HTMLElement, content: HTMLElement, meta: HTMLElement, start: HTMLElement, links: HTMLElement}}
 */
const dom = {
  list: requireElement('docs-list'),
  toc: requireElement('docs-toc'),
  content: requireElement('docs-content'),
  meta: requireElement('docs-meta'),
  start: requireElement('docs-start'),
  links: requireElement('docs-links'),
};

/**
 * @typedef {Object} LoadedDocument
 * @property {string} path
 * @property {string|null} text null when the fetch failed
 * @property {Error|null} error
 * @property {number|null} status HTTP status, or 0 for a network failure
 * @property {number|null} bytes
 * @property {number|null} loadedAt
 * @property {boolean} loading
 */

/** @type {Map<string, LoadedDocument>} */
const cache = new Map();

/** The document shown in the content pane. */
let selected = DOCUMENTS[0]?.path ?? '/llm.txt';

function main() {
  renderPageChrome('/docs');
  renderStartHere();
  renderDocList();

  const fromHash = location.hash.replace(/^#/, '');
  if (fromHash !== '' && DOCUMENTS.some((doc) => hashOf(doc.path) === fromHash || doc.path === fromHash)) {
    const match = DOCUMENTS.find((doc) => hashOf(doc.path) === fromHash || doc.path === fromHash);
    if (match) selected = match.path;
  }

  window.addEventListener('hashchange', () => {
    const target = location.hash.replace(/^#/, '');
    if (target === hashOf(selected)) return; // we set this hash ourselves
    const match = DOCUMENTS.find((doc) => hashOf(doc.path) === target);
    if (match) {
      selected = match.path;
      render();
    }
  });

  render();
}

// ---------------------------------------------------------------------------
// Fixed parts
// ---------------------------------------------------------------------------

function renderStartHere() {
  clearNode(dom.start);
  dom.start.appendChild(
    h(
      'div',
      { class: 'tile-grid' },
      START_HERE.map((entry) =>
        h(
          'article',
          { class: 'tile' },
          h('h3', { class: 'tile-title' }, h('a', { class: 'link', href: entry.href, text: entry.title })),
          h('p', { class: 'note', text: entry.body }),
        ),
      ),
    ),
  );
  clearNode(dom.links);
  dom.links.appendChild(
    h(
      'p',
      { class: 'note' },
      'Source of truth on disk: ',
      h('code', { text: 'docs/*.md' }),
      ' and ',
      h('code', { text: 'llm.txt' }),
      ' · sibling pages: ',
      navItems()
        .filter((item) => item.href !== '/docs')
        .flatMap((item, index) => [
          index === 0 ? null : ' \u00b7 ',
          h('a', { class: 'link', href: item.href, text: item.label }),
        ])
        .filter((node) => node !== null),
    ),
  );
}

function renderDocList() {
  clearNode(dom.list);
  for (const doc of DOCUMENTS) {
    const state = cache.get(doc.path);
    dom.list.appendChild(
      h(
        'li',
        { class: 'docs-list-item' },
        h('a', {
          class: 'docs-link',
          href: `#${hashOf(doc.path)}`,
          'aria-current': doc.path === selected ? 'true' : null,
          onclick: (/** @type {Event} */ event) => {
            event.preventDefault();
            select(doc.path);
          },
        }, h('span', { class: 'docs-link-label', text: doc.label }), ' ', h('span', { class: 'badge badge-muted', text: doc.audience })),
        h('p', { class: 'note', text: doc.blurb }),
        state && state.error ? h('p', { class: 'note warn-text', text: `unavailable: ${describeError(state)}` }) : null,
        state && state.text !== null && state.bytes !== null
          ? h('p', { class: 'note muted small', text: `${formatBytes(state.bytes)} · loaded ${formatRelative(state.loadedAt ?? undefined)}` })
          : null,
      ),
    );
  }
}

/**
 * @param {string} path
 * @returns {void}
 */
function select(path) {
  selected = path;
  if (location.hash !== `#${hashOf(path)}`) location.hash = hashOf(path);
  render();
}

/**
 * @param {string} path e.g. `/docs/RNG.md`
 * @returns {string} an anchor-safe id, e.g. `docs-RNG-md`
 */
function hashOf(path) {
  return path.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  renderDocList();
  const doc = DOCUMENTS.find((candidate) => candidate.path === selected) ?? DOCUMENTS[0];
  if (!doc) return;

  const state = cache.get(doc.path);
  if (!state) {
    void load(doc.path);
    return;
  }
  if (state.loading) {
    setTextMeta(`${doc.path} · loading…`);
    clearNode(dom.toc);
    clearNode(dom.content);
    dom.content.appendChild(h('p', { class: 'muted', text: `Fetching ${doc.path}…` }));
    return;
  }
  if (state.error) {
    const status = state.status;
    clearNode(dom.toc);
    dom.toc.appendChild(h('p', { class: 'muted', text: 'No table of contents — the document could not be read.' }));
    clearNode(dom.content);
    dom.content.appendChild(
      status === 404
        ? banner(
            'error',
            `${doc.path} is not served by this deployment (404)`,
            'The documentation hub renders real files from the repository, so when one is missing there is nothing to show. ' +
              'Nothing is substituted or invented here. The other documents in the list on the left are unaffected.',
            `GET ${doc.path} → 404`,
          )
        : banner(
            'error',
            `Could not load ${doc.path}`,
            `${describeError(state)} This is a fetch failure in your browser, not a verdict about the document. ` +
              'Try the raw file link, and check that the server is reachable.',
            null,
          ),
    );
    dom.content.appendChild(
      h('p', { class: 'note' }, h('a', { class: 'link', href: doc.path, text: `Open ${doc.path} raw →` })),
    );
    setTextMeta(`${doc.path} · unavailable`);
    return;
  }

  const text = state.text ?? '';
  const contents = tableOfContents(text);
  renderToc(doc, contents);
  renderDocument(doc, text, state);
}

/**
 * The content pane: a `<pre>` whose content is set with `textContent`. Not
 * `innerHTML`, not a markdown parser — the document is data.
 *
 * @param {{path: string, label: string}} doc
 * @param {string} text
 * @param {LoadedDocument} state
 * @returns {void}
 */
function renderDocument(doc, text, state) {
  clearNode(dom.content);
  dom.content.appendChild(
    h(
      'div',
      { class: 'docs-doc-head' },
      h('p', { class: 'note' }, h('a', { class: 'link', href: doc.path, text: `Open ${doc.path} raw (${formatBytes((state.bytes ?? text.length) || 0)}) →` })),
      h('p', {
        class: 'note muted small',
        text:
          'Rendered as plain text: this page never parses markdown into HTML, so no document can inject markup or script into it.',
      }),
    ),
  );
  dom.content.appendChild(h('pre', { class: 'docs-text', tabindex: '0', 'aria-label': `${doc.path} contents`, text }));
  setTextMeta(`${doc.path} · ${formatBytes(state.bytes ?? text.length)} · fetched ${formatRelative(state.loadedAt ?? undefined)}`);
}

/**
 * @param {{path: string, label: string}} doc
 * @param {TocEntry[]} entries
 * @returns {void}
 */
function renderToc(doc, entries) {
  clearNode(dom.toc);
  dom.toc.appendChild(h('p', { class: 'docs-toc-title', text: `${doc.label} contents` }));
  if (entries.length === 0) {
    dom.toc.appendChild(h('p', { class: 'muted small', text: 'This document has no headings.' }));
    return;
  }
  dom.toc.appendChild(
    h(
      'ul',
      { class: 'docs-toc-list' },
      entries.map((entry) =>
        h(
          'li',
          { class: `docs-toc-item docs-toc-level-${entry.level}` },
          h('a', { class: 'link', href: `#${hashOf(doc.path)}`, dataset: { line: String(entry.line) }, text: entry.title }),
        ),
      ),
    ),
  );
  dom.toc.appendChild(
    h('p', {
      class: 'note muted small',
      text: 'Headings are derived from the document text; the file itself is unchanged.',
    }),
  );
}

/**
 * @param {string} text
 * @returns {void}
 */
function setTextMeta(text) {
  setText(dom.meta, text);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Fetches one document as **text** and caches it. Never throws: a failure is
 * recorded on the entry so the pane can describe it.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
async function load(path) {
  const existing = cache.get(path);
  if (existing && (existing.loading || existing.text !== null)) return;
  cache.set(path, { path, text: null, error: null, status: null, bytes: null, loadedAt: null, loading: true });
  if (path === selected) render();
  dom.meta = requireElement('docs-meta');
  try {
    const response = await fetch(absoluteUrl(path), { headers: { accept: 'text/plain, text/markdown, */*' }, cache: 'no-store' });
    if (!response.ok) {
      cache.set(path, {
        path,
        text: null,
        error: new Error(`GET ${path} returned ${response.status} ${response.statusText || ''}`.trim()),
        status: response.status,
        bytes: null,
        loadedAt: Date.now(),
        loading: false,
      });
    } else {
      const body = await response.text();
      cache.set(path, {
        path,
        text: body,
        error: null,
        status: response.status,
        // `Content-Length` when the server sent it, else the decoded length.
        bytes: Number(response.headers.get('content-length')) || body.length,
        loadedAt: Date.now(),
        loading: false,
      });
    }
  } catch (err) {
    cache.set(path, {
      path,
      text: null,
      error: err instanceof Error ? err : new Error(String(err)),
      status: 0,
      bytes: null,
      loadedAt: Date.now(),
      loading: false,
    });
  }
  renderDocList();
  if (path === selected) render();
}

/**
 * @param {LoadedDocument} state
 * @returns {string}
 */
function describeError(state) {
  if (!state.error) return 'unknown error';
  if (state.status === 0) return `the request never completed (${state.error.message})`;
  return state.error.message;
}

/**
 * A document path is always same-origin. It is resolved against the page anyway,
 * so the fetch works identically in a browser and in a headless DOM check that
 * has no document base URL of its own.
 *
 * @param {string} path
 * @returns {string}
 */
function absoluteUrl(path) {
  try {
    return new URL(path, location.href).toString();
  } catch {
    return path;
  }
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TocEntry
 * @property {number} level 1..6
 * @property {string} title
 * @property {number} line 1-based line number in the document
 */

/**
 * ATX headings (`# ` .. `###### `), skipping fenced code blocks. A heading must
 * be followed by a space or end-of-line, so `#hashtag` is not a heading.
 *
 * @param {string} text
 * @returns {TocEntry[]}
 */
export function tableOfContents(text) {
  if (typeof text !== 'string' || text === '') return [];
  /** @type {TocEntry[]} */
  const entries = [];
  let fence = null;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      if (fence === null) fence = marker.slice(0, 1);
      else if (marker.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!match) continue;
    const level = (match[1] ?? '#').length;
    const title = (match[2] ?? '').replace(/\s+#+\s*$/, '').trim();
    if (title === '') continue;
    entries.push({ level, title, line: index + 1 });
  }
  return entries;
}

/** The first-line summary displayed next to the hub title. */
main();
