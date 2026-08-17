// Demo-only traffic generator template: periodically inserts a new document
// and touches an existing one, so the viewer's sort-by-last-activity +
// blink-on-change feature has something to show. Copy to simulate.js
// (gitignored) and adapt the collection/field names to your own schema.
// Run alongside `npm start` in a separate terminal; stop with Ctrl+C.
require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB;
const INTERVAL_MS = 4000;

if (!MONGODB_URI || !MONGODB_DB) {
  console.error('Missing MONGODB_URI or MONGODB_DB in .env');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);

const CATEGORIES = ['A', 'B', 'C', 'D'];
const STATUSES = ['completed', 'pending'];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function insertSimulatedRecord(db) {
  const name = `SIM-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const doc = {
    name,
    category: randomFrom(CATEGORIES),
    amount: Math.round(Math.random() * 10000) / 100,
    status: randomFrom(STATUSES),
    createdAt: new Date(),
  };
  await db.collection('example_collection').insertOne(doc);
  console.log(`[example_collection] inserted ${name}`);
}

async function touchRandomRecord(db) {
  const count = await db.collection('example_collection').estimatedDocumentCount();
  if (count === 0) return;
  const skip = Math.floor(Math.random() * count);
  const [doc] = await db.collection('example_collection').find({}).skip(skip).limit(1).toArray();
  if (!doc) return;
  await db.collection('example_collection').updateOne({ _id: doc._id }, { $set: { updatedAt: new Date() } });
  console.log(`[example_collection] touched updatedAt on ${doc._id}`);
}

async function tick(db) {
  try {
    if (Math.random() < 0.5) {
      await insertSimulatedRecord(db);
    } else {
      await touchRandomRecord(db);
    }
  } catch (err) {
    console.error('Simulation tick failed:', err.message);
  }
}

async function start() {
  await client.connect();
  const db = client.db(MONGODB_DB);
  console.log(`Simulating writes into "${MONGODB_DB}" every ${INTERVAL_MS / 1000}s. Ctrl+C to stop.`);
  await tick(db);
  setInterval(() => tick(db), INTERVAL_MS);
}

start().catch((err) => {
  console.error('Failed to start simulator:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await client.close();
  process.exit(0);
});
