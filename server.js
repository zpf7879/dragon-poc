require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGODB_DB = process.env.MONGODB_DB;
const MONGODB_USER = process.env.MONGODB_USER;
const MONGODB_PASS = process.env.MONGODB_PASS;
const NODE_HOSTS = (process.env.MONGODB_NODE_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
// Optional: path to a CA cert file, for self-hosted clusters signed by a
// private CA (e.g. an on-prem replica set) rather than a publicly trusted
// one like Atlas. Leave unset to use the system's default trust store.
const MONGODB_TLS_CA_FILE = process.env.MONGODB_TLS_CA_FILE || undefined;

if (!MONGODB_DB || !MONGODB_USER || !MONGODB_PASS || NODE_HOSTS.length === 0) {
  console.error('Missing MONGODB_DB / MONGODB_USER / MONGODB_PASS / MONGODB_NODE_HOSTS in .env');
  process.exit(1);
}
if (MONGODB_TLS_CA_FILE && !fs.existsSync(MONGODB_TLS_CA_FILE)) {
  console.error(`MONGODB_TLS_CA_FILE is set to "${MONGODB_TLS_CA_FILE}" but that file doesn't exist`);
  process.exit(1);
}

// Short, stable labels for the UI — "Node A (00-00)" instead of the full
// Atlas shard hostname. Falls back to a plain ordinal if a host doesn't match
// the expected "shard-XX-YY" naming.
function shortNameFor(host, index) {
  const m = host.match(/shard-(\d+-\d+)/);
  const letter = String.fromCharCode(65 + index);
  return m ? `Node ${letter} (${m[1]})` : `Node ${letter}`;
}

// One direct connection per replica set member, bypassing Atlas's SRV-based
// routing so each panel reads from a specific, named node rather than
// whichever member the driver's topology logic would pick. directConnection
// pins the client to exactly that host; secondaryPreferred is required
// alongside it so reads succeed whether the node is primary or secondary.
const nodes = NODE_HOSTS.map((host, index) => ({
  index,
  host,
  shortName: shortNameFor(host, index),
  client: new MongoClient(
    `mongodb://${encodeURIComponent(MONGODB_USER)}:${encodeURIComponent(MONGODB_PASS)}@${host}/${MONGODB_DB}` +
      `?directConnection=true&authSource=admin&appName=NodeViewer-${index}`,
    {
      tls: true,
      // Passed as a client option rather than a URI query param, since a
      // Windows file path (backslashes, drive letter, spaces) doesn't survive
      // being embedded in a URI without extra encoding headaches.
      ...(MONGODB_TLS_CA_FILE ? { tlsCAFile: MONGODB_TLS_CA_FILE } : {}),
      readPreference: 'secondaryPreferred',
      maxPoolSize: 10, // three separate node clients now instead of one — smaller pool each
      minPoolSize: 2,
      maxIdleTimeMS: 600000,
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 5000,
      waitQueueTimeoutMS: 5000,
    }
  ),
}));

const DOC_LIMIT = 50; // cap rows returned per collection to keep the UI responsive

// Per-collection display config lives in collection-config.json (gitignored —
// see collection-config.example.json for the shape), not in source, since
// collection/field names describe someone's actual database schema.
// - activityFields: field(s) that indicate a doc was inserted/updated, newest
//   wins. Every collection also gets the ObjectId's embedded creation time as
//   a guaranteed fallback, so an unconfigured collection still sorts by insert time.
// - displayFields: 4 representative fields per collection (+ "Last activity"
//   always prepended = 5 columns), so panels stay readable. An unconfigured
//   collection just shows every field instead of being restricted.
const CONFIG_PATH = path.join(__dirname, 'collection-config.json');
let collectionConfig = { activityFields: {}, displayFields: {} };
if (fs.existsSync(CONFIG_PATH)) {
  collectionConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} else {
  console.warn(`No collection-config.json found — see collection-config.example.json. Falling back to showing all fields.`);
}
const ACTIVITY_FIELDS = collectionConfig.activityFields || {};
const DISPLAY_FIELDS = collectionConfig.displayFields || {};

function findNode(indexParam) {
  const index = Number(indexParam);
  return nodes.find((n) => n.index === index);
}

async function getNodeRole(node) {
  const result = await node.client.db('admin').command({ hello: 1 });
  let role = 'UNKNOWN';
  if (result.isWritablePrimary || result.ismaster) role = 'PRIMARY';
  else if (result.secondary) role = 'SECONDARY';
  else if (result.arbiterOnly) role = 'ARBITER';
  return { host: node.host, role, setName: result.setName || null };
}

const app = express();
app.use(express.static('public'));

app.get('/api/nodes', (req, res) => {
  res.json(nodes.map((n) => ({ index: n.index, host: n.host, shortName: n.shortName })));
});

app.get('/api/nodes/:index/status', async (req, res) => {
  const node = findNode(req.params.index);
  if (!node) return res.status(404).json({ error: 'Unknown node' });
  try {
    res.json({ ...(await getNodeRole(node)), reachable: true });
  } catch (err) {
    res.json({ host: node.host, role: 'UNREACHABLE', reachable: false, error: err.message });
  }
});

app.get('/api/collections', async (req, res) => {
  try {
    // Collection names are schema, not per-node data, so any reachable node will do.
    const db = nodes[0].client.db(MONGODB_DB);
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    res.json(collections.map((c) => c.name).sort());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list collections' });
  }
});

app.get('/api/nodes/:index/collections/:name/documents', async (req, res) => {
  const node = findNode(req.params.index);
  if (!node) return res.status(404).json({ error: 'Unknown node' });

  try {
    const db = node.client.db(MONGODB_DB);

    // Only allow querying collections that actually exist, rather than trusting
    // the client-supplied name outright.
    const known = await db.listCollections({}, { nameOnly: true }).toArray();
    const names = new Set(known.map((c) => c.name));
    if (!names.has(req.params.name)) {
      return res.status(404).json({ error: 'Unknown collection' });
    }

    const activityFields = ACTIVITY_FIELDS[req.params.name] || [];
    const displayFields = DISPLAY_FIELDS[req.params.name];
    // No display config for this collection -> don't restrict projection; the
    // client falls back to showing every field it gets back.
    const columns = displayFields ? [{ key: '_lastActivityAt', label: 'Last activity' }, ...displayFields] : null;

    const pipeline = [
      {
        $addFields: {
          // $max ignores null/missing candidates. Candidates: the ObjectId's
          // embedded creation time (falls back to null via $convert's
          // onError/onNull for collections with non-ObjectId _id values,
          // which $toDate can't convert), window_end (set on stream-processing
          // output docs), and any collection-specific activity fields.
          _lastActivityAt: {
            $max: [
              { $convert: { input: '$_id', to: 'date', onError: null, onNull: null } },
              '$window_end',
              ...activityFields.map((f) => `$${f}`),
            ],
          },
        },
      },
      { $sort: { _lastActivityAt: -1 } },
      { $limit: DOC_LIMIT },
    ];
    if (columns) {
      // Trim to just the id (needed client-side to track row identity) plus
      // the columns we're actually displaying, instead of every field.
      pipeline.push({ $project: Object.fromEntries([['_id', 1], ...columns.map((c) => [c.key, 1])]) });
    }

    const [documents, total] = await Promise.all([
      db.collection(req.params.name).aggregate(pipeline).toArray(),
      db.collection(req.params.name).estimatedDocumentCount(),
    ]);

    res.json({ documents, total, returned: documents.length, limit: DOC_LIMIT, columns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch documents from this node' });
  }
});

async function start() {
  await Promise.all(nodes.map((n) => n.client.connect()));
  app.listen(PORT, () => {
    console.log(`MongoDB node viewer running at http://localhost:${PORT}`);
    nodes.forEach((n) => console.log(`  node ${n.index}: ${n.host}`));
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await Promise.all(nodes.map((n) => n.client.close()));
  process.exit(0);
});
