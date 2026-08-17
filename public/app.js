const POLL_INTERVAL_MS = 5000;

const collectionSelect = document.getElementById('collectionSelect');
const metaEl = document.getElementById('meta');
const panelsEl = document.getElementById('panels');

let currentCollection = null;
let panels = []; // [{ index, host, el, statusEl, metaEl, tableWrap, roleBadge, snapshot }]

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
  return escapeHtml(String(value));
}

function renderTable(tableWrap, documents, columns, changedIds) {
  if (documents.length === 0) {
    tableWrap.innerHTML = '<p>No documents.</p>';
    return;
  }

  // Server sends columns=null for collections with no display config — fall
  // back to the union of whatever top-level keys are present.
  if (!columns) {
    const keys = new Set(['_lastActivityAt', '_id']);
    documents.forEach((doc) => Object.keys(doc).forEach((k) => keys.add(k)));
    columns = Array.from(keys).map((k) => ({ key: k, label: k === '_lastActivityAt' ? 'Last activity' : k }));
  }

  const thead = `<thead><tr>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>`;
  const rows = documents
    .map((doc) => {
      const rowClass = changedIds.has(doc._id) ? ' class="row-changed"' : '';
      const cells = columns.map((c) => `<td>${formatValue(doc[c.key])}</td>`).join('');
      return `<tr${rowClass}>${cells}</tr>`;
    })
    .join('');

  tableWrap.innerHTML = `<table>${thead}<tbody>${rows}</tbody></table>`;
}

function setRoleBadge(badgeEl, role) {
  badgeEl.textContent = role;
  badgeEl.className = `role-badge role-${role.toLowerCase()}`;
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
      <div class="panel-table"></div>
    `;
    panelsEl.appendChild(el);
    return {
      index: node.index,
      host: node.host,
      el,
      roleBadge: el.querySelector('.role-badge'),
      metaEl: el.querySelector('.panel-meta'),
      statusEl: el.querySelector('.panel-status'),
      tableWrap: el.querySelector('.panel-table'),
      snapshot: null, // Map(_id -> _lastActivityAt) from the previous poll, per collection switch
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
      next.set(doc._id, doc._lastActivityAt);
      if (previous && previous.get(doc._id) !== doc._lastActivityAt) {
        changedIds.add(doc._id);
      }
    });
    panel.snapshot = next;

    panel.statusEl.textContent = '';
    panel.metaEl.textContent = `${returned} of ~${total} (limit ${limit})`;
    renderTable(panel.tableWrap, documents, columns, changedIds);
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
    p.tableWrap.innerHTML = '';
    p.statusEl.textContent = `Loading "${currentCollection}"…`;
  });
  pollAll();
});

(async () => {
  await loadNodes();
  await loadCollections();
  await pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
})();
