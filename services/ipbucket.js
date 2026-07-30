const fs = require("fs");
const crypto = require("crypto");

const KEY_FILE = "./auth/iphash.key";
const WATCH_FILE = "./auth/ipwatch.json";
const BUCKET_HEX_CHARS = 4;

let key = null;
let watched = null;

const getKey = () => {
  if (key) return key;

  if (process.env.IP_HASH_KEY) {
    key = process.env.IP_HASH_KEY;
    return key;
  }

  try {
    key = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (key) return key;
  } catch {}

  key = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync("./auth", { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  } catch (error) {
    console.error("Could not persist the IP hash key, buckets will change on restart:", error.message);
  }
  return key;
};

const bucketFor = (ip) => {
  if (!ip) return "";
  return crypto
    .createHmac("sha256", getKey())
    .update(ip)
    .digest("hex")
    .substring(0, BUCKET_HEX_CHARS);
};

const loadWatched = () => {
  if (watched) return watched;
  try {
    watched = new Set(JSON.parse(fs.readFileSync(WATCH_FILE, "utf8")).buckets || []);
  } catch {
    watched = new Set();
  }
  return watched;
};

const saveWatched = () => {
  fs.mkdirSync("./auth", { recursive: true });
  fs.writeFileSync(WATCH_FILE, JSON.stringify({ buckets: [...loadWatched()] }, null, 2));
};

const isWatched = (bucket) => loadWatched().has(bucket);

const watchBucket = (bucket) => {
  loadWatched().add(bucket);
  saveWatched();
};

const unwatchBucket = (bucket) => {
  const removed = loadWatched().delete(bucket);
  saveWatched();
  return removed;
};

const listWatched = () => [...loadWatched()];

module.exports = { bucketFor, isWatched, watchBucket, unwatchBucket, listWatched };
