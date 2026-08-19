const POLL_INTERVAL_MS = 5000;

const collectionSelect = document.getElementById('collectionSelect');
const foldAllBtn = document.getElementById('foldAllBtn');
const unfoldAllBtn = document.getElementById('unfoldAllBtn');
const metaEl = document.getElementById('meta');
const panelsEl = document.getElementById('panels');

let currentCollection = null;
let panels = []; // [{ index, host, el, statusEl, metaEl, cardsWrap, roleBadge, snapshot, collapsedIds }]

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// _id isn't guaranteed to be a primitive (some collections use compound/object
// _id values) — String(obj) collapses every such doc to "[object Object]",
// and using the raw object as a Map/Set key never matches across polls since
// each fetch().json() call parses a fresh object. Use a stable string instead.
function idKey(id) {
  return typeof id === 'object' && id !== null ? JSON.stringify(id) : String(id);
}

function formatValue(value) {
  if (value === null || value === undefined) return '<span class="field-empty">—</span>';
  if (typeof value === 'object') return `<pre class="field-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  return escapeHtml(String(value));
}

// _id can be a compound/object key rather than a scalar. A single JSON blob
// is hard to scan as a title, so spell out each of its fields as its own
// labeled chip instead — same visual language as the field rows below it.
function formatIdTitle(id) {
  if (typeof id !== 'object' || id === null) return escapeHtml(String(id));
  return Object.entries(id)
    .map(([k, v]) => {
      const text = v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `<span class="id-field"><span class="id-field-key">${escapeHtml(k)}</span><span class="id-field-value">${escapeHtml(text)}</span></span>`;
    })
    .join('');
}

// Renders each document as a standalone "tablet": _id is always shown as the
// card title (it's the row identity, so there's no point hiding it), while
// every other field lives in a body that can be folded away per document.
// collapsedIds persists fold state across polls so a 5s refresh doesn't snap
// a folded card back open.
function renderCards(cardsWrap, documents, columns, changedIds, collapsedIds) {
  if (documents.length === 0) {
    cardsWrap.innerHTML = '<p>No documents.</p>';
    return;
  }

  // Server sends columns=null for collections with no display config — fall
  // back to the union of whatever top-level keys are present (minus _id,
  // which is rendered separately as the title).
  let fields = columns ? columns.filter((c) => c.key !== '_id') : null;
  if (!fields) {
    const keys = new Set(['_lastActivityAt']);
    documents.forEach((doc) => Object.keys(doc).forEach((k) => k !== '_id' && keys.add(k)));
    fields = Array.from(keys).map((k) => ({ key: k, label: k === '_lastActivityAt' ? 'Last activity' : k }));
  }

  cardsWrap.innerHTML = documents
    .map((doc) => {
      const id = idKey(doc._id);
      const collapsed = collapsedIds.has(id);
      const changedClass = changedIds.has(id) ? ' card-changed' : '';
      const rows = fields
        .map(
          (c) => `
            <div class="field-row">
              <div class="field-key">${escapeHtml(c.label)}</div>
              <div class="field-value">${formatValue(doc[c.key])}</div>
            </div>`
        )
        .join('');
      return `
        <section class="doc-card${collapsed ? ' collapsed' : ''}${changedClass}" data-id="${escapeHtml(id)}">
          <button type="button" class="doc-card-header" aria-expanded="${!collapsed}">
            <span class="doc-card-chevron" aria-hidden="true"></span>
            <span class="doc-card-title">${formatIdTitle(doc._id)}</span>
          </button>
          <div class="doc-card-body">${rows}</div>
        </section>`;
    })
    .join('');
}

function setRoleBadge(badgeEl, role) {
  badgeEl.textContent = role;
  badgeEl.className = `role-badge role-${role.toLowerCase()}`;
}

// Toggles a single already-rendered card and keeps collapsedIds (which
// survives across polls) in sync with the DOM.
function setCardCollapsed(card, collapsedIds, collapsed) {
  const header = card.querySelector('.doc-card-header');
  card.classList.toggle('collapsed', collapsed);
  header.setAttribute('aria-expanded', String(!collapsed));
  if (collapsed) collapsedIds.add(card.dataset.id);
  else collapsedIds.delete(card.dataset.id);
}

function setPanelCollapsed(panel, collapsed) {
  panel.cardsWrap.querySelectorAll('.doc-card').forEach((card) => setCardCollapsed(card, panel.collapsedIds, collapsed));
}

function buildPanels(nodeList) {
  panelsEl.innerHTML = '';
  panels = nodeList.map((node) => {
    const el = document.createElement('section');
    el.className = `panel panel-${node.index}`;
    el.innerHTML = `
      <div class="panel-header">
        <span class="node-host" title="${escapeHtml(node.host)}">${escapeHtml(node.shortName)}</span>
        <span class="role-badge role-unknown">…</span>
      </div>
      <div class="panel-meta"></div>
      <div class="panel-status">Connecting…</div>
      <div class="panel-cards"></div>
    `;
    panelsEl.appendChild(el);
    const cardsWrap = el.querySelector('.panel-cards');
    const collapsedIds = new Set();
    cardsWrap.addEventListener('click', (e) => {
      const header = e.target.closest('.doc-card-header');
      if (!header) return;
      const card = header.closest('.doc-card');
      setCardCollapsed(card, collapsedIds, !card.classList.contains('collapsed'));
    });
    return {
      index: node.index,
      host: node.host,
      el,
      roleBadge: el.querySelector('.role-badge'),
      metaEl: el.querySelector('.panel-meta'),
      statusEl: el.querySelector('.panel-status'),
      cardsWrap,
      snapshot: null, // Map(_id -> _lastActivityAt) from the previous poll, per collection switch
      collapsedIds, // Set(_id) of tablets folded shut, per collection switch
    };
  });
}

async function pollNodeStatus(panel) {
  try {
    const res = await fetch(`/api/nodes/${panel.index}/status`);
    const status = await res.json();
    setRoleBadge(panel.roleBadge, status.reachable ? status.role : 'UNREACHABLE');
  } catch {
    setRoleBadge(panel.roleBadge, 'UNREACHABLE');
  }
}

async function pollNodeDocuments(panel) {
  if (!currentCollection) return;
  const name = currentCollection;

  try {
    const res = await fetch(`/api/nodes/${panel.index}/collections/${encodeURIComponent(name)}/documents`);
    if (name !== currentCollection) return; // collection changed while in flight
    if (!res.ok) {
      panel.statusEl.textContent = `Failed to load "${name}" from this node.`;
      return;
    }
    const { documents, total, returned, limit, columns } = await res.json();
    if (name !== currentCollection) return;

    const previous = panel.snapshot; // null on first load for this collection
    const changedIds = new Set();
    const next = new Map();
    documents.forEach((doc) => {
      const id = idKey(doc._id);
      next.set(id, doc._lastActivityAt);
      if (previous && previous.get(id) !== doc._lastActivityAt) {
        changedIds.add(id);
      }
    });
    panel.snapshot = next;

    panel.statusEl.textContent = '';
    panel.metaEl.textContent = `${returned} of ~${total} (limit ${limit})`;
    renderCards(panel.cardsWrap, documents, columns, changedIds, panel.collapsedIds);
  } catch (err) {
    panel.statusEl.textContent = `Error: ${err.message}`;
  }
}

async function pollAll() {
  await Promise.all(panels.flatMap((p) => [pollNodeStatus(p), pollNodeDocuments(p)]));
}

async function loadCollections() {
  const res = await fetch('/api/collections');
  if (!res.ok) {
    metaEl.textContent = 'Failed to load collections.';
    return;
  }
  const names = await res.json();
  collectionSelect.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if (names.length > 0) currentCollection = names[0];
}

async function loadNodes() {
  const res = await fetch('/api/nodes');
  if (!res.ok) {
    metaEl.textContent = 'Failed to load nodes.';
    return;
  }
  buildPanels(await res.json());
}

collectionSelect.addEventListener('change', (e) => {
  currentCollection = e.target.value;
  panels.forEach((p) => {
    p.snapshot = null; // don't blink the whole panel just because we switched views
    p.collapsedIds.clear(); // fold state belongs to the previous collection's docs
    p.cardsWrap.innerHTML = '';
    p.statusEl.textContent = `Loading "${currentCollection}"…`;
  });
  pollAll();
});

foldAllBtn.addEventListener('click', () => panels.forEach((p) => setPanelCollapsed(p, true)));
unfoldAllBtn.addEventListener('click', () => panels.forEach((p) => setPanelCollapsed(p, false)));

(async () => {
  await loadNodes();
  await loadCollections();
  await pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
})();
