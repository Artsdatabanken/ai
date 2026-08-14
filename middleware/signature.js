const crypto = require("crypto");
const { writeErrorLog, writeRejectionLog } = require("../services/logging");

const SIGNATURE_VERSION = "v1";
const MAX_SKEW_SECONDS = 300;
const TIMESTAMP_HEADER = "x-artsorakel-timestamp";
const SIGNATURE_HEADER = "x-artsorakel-signature";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

const canonicalString = (req, timestamp) => {
  const imageHashes = (Array.isArray(req.files) ? req.files : [])
    .map((file) => sha256(file.buffer))
    .join("\n");

  const body = req.body || {};
  const fields = Object.keys(body)
    .sort()
    .map((key) => `${key}=${body[key]}`)
    .join("\n");

  return [
    SIGNATURE_VERSION,
    req.method,
    req.path,
    req.auth.token,
    timestamp,
    sha256(`${imageHashes}\n${fields}`)
  ].join("\n");
};

const signWith = (secret, canonical) =>
  crypto.createHmac("sha256", secret).update(canonical).digest("hex");

const matches = (expected, provided) => {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const reject = (req, res, reason) => {
  writeErrorLog(
    "Request signature rejected",
    `IP ${req.ip}, token ${String(req.auth?.token).substring(0, 10)}..., ${reason}`
  );
  writeRejectionLog(req, req.auth, `signature: ${reason}`);
  return res.status(401).json({
    error: "Invalid request signature.",
    message: "This token requires a signed request."
  });
};

const verifyRequestSignature = (req, res, next) => {
  if (!req.auth?.secret) return next();

  const timestamp = req.headers[TIMESTAMP_HEADER];
  const signature = req.headers[SIGNATURE_HEADER];

  if (!timestamp || !signature) {
    return reject(req, res, "missing timestamp or signature header");
  }

  if (!/^\d+$/.test(String(timestamp))) {
    return reject(req, res, "malformed timestamp");
  }

  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (skew > MAX_SKEW_SECONDS) {
    return reject(req, res, `timestamp ${skew}s outside the ${MAX_SKEW_SECONDS}s window`);
  }

  const [version, provided] = String(signature).split("=");
  if (version !== SIGNATURE_VERSION || !provided) {
    return reject(req, res, "unsupported signature version");
  }

  const canonical = canonicalString(req, String(timestamp));
  const secrets = [req.auth.secret, req.auth.previousSecret].filter(Boolean);

  for (const secret of secrets) {
    if (matches(signWith(secret, canonical), provided)) {
      return next();
    }
  }

  return reject(req, res, "signature mismatch");
};

module.exports = { verifyRequestSignature, canonicalString, signWith, SIGNATURE_VERSION };

if (require.main === module && process.argv.includes("--selftest")) {
  const assert = require("assert");

  const secret = "a".repeat(64);
  const previousSecret = "b".repeat(64);
  const now = () => String(Math.floor(Date.now() / 1000));

  const makeReq = (overrides = {}) => ({
    method: "POST",
    path: "/identify",
    ip: "127.0.0.1",
    headers: {},
    body: { application: "Partner1.0", latitude: "59.9", longitude: "10.7" },
    files: [{ buffer: Buffer.from("first image") }, { buffer: Buffer.from("second image") }],
    auth: { type: "api", token: "tok_12345678", secret },
    ...overrides
  });

  const sign = (req, timestamp, withSecret = secret) => {
    req.headers[TIMESTAMP_HEADER] = timestamp;
    req.headers[SIGNATURE_HEADER] =
      `${SIGNATURE_VERSION}=${signWith(withSecret, canonicalString(req, timestamp))}`;
    return req;
  };

  const run = (req) => {
    let status = null;
    let passed = false;
    const res = { status: (code) => { status = code; return { json: () => {} }; } };
    verifyRequestSignature(req, res, () => { passed = true; });
    return { passed, status };
  };

  assert.strictEqual(run(sign(makeReq(), now())).passed, true);

  assert.strictEqual(run(makeReq()).passed, false);

  const noSecret = makeReq({ auth: { type: "api", token: "tok_12345678" } });
  assert.strictEqual(run(noSecret).passed, true);

  const wrongSecret = sign(makeReq(), now(), "c".repeat(64));
  assert.strictEqual(run(wrongSecret).passed, false);

  const stale = sign(makeReq(), String(Math.floor(Date.now() / 1000) - MAX_SKEW_SECONDS - 60));
  assert.strictEqual(run(stale).passed, false);

  const future = sign(makeReq(), String(Math.floor(Date.now() / 1000) + MAX_SKEW_SECONDS + 60));
  assert.strictEqual(run(future).passed, false);

  const tamperedBody = sign(makeReq(), now());
  tamperedBody.body.latitude = "55.6";
  assert.strictEqual(run(tamperedBody).passed, false);

  const tamperedImage = sign(makeReq(), now());
  tamperedImage.files[1] = { buffer: Buffer.from("swapped image") };
  assert.strictEqual(run(tamperedImage).passed, false);

  const extraImage = sign(makeReq(), now());
  extraImage.files.push({ buffer: Buffer.from("added image") });
  assert.strictEqual(run(extraImage).passed, false);

  const otherToken = sign(makeReq(), now());
  otherToken.auth.token = "tok_87654321";
  assert.strictEqual(run(otherToken).passed, false);

  const rotating = makeReq({
    auth: { type: "api", token: "tok_12345678", secret, previousSecret }
  });
  assert.strictEqual(run(sign(rotating, now(), previousSecret)).passed, true);

  const noRotation = sign(makeReq(), now(), previousSecret);
  assert.strictEqual(run(noRotation).passed, false);

  const badVersion = sign(makeReq(), now());
  badVersion.headers[SIGNATURE_HEADER] =
    badVersion.headers[SIGNATURE_HEADER].replace("v1=", "v2=");
  assert.strictEqual(run(badVersion).passed, false);

  console.log("signature selftest passed");
}
