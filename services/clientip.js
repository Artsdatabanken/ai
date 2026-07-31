const PRIVATE_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\./,
  /^::1$/,
  /^[fF][cCdD]/,
  /^[fF][eE][89aAbB]/,
];

const isPrivateIP = (ip) => !ip || PRIVATE_RANGES.some((range) => range.test(ip));

const cleanIP = (value) => {
  if (!value) return null;

  let ip = String(value).replace(/^::ffff:/i, "").trim();

  const ipv4WithPort = ip.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
  if (ipv4WithPort) {
    ip = ipv4WithPort[1];
  }

  // "[2001:db8::1]:443" - proxies bracket IPv6 when they append a port
  const bracketed = ip.match(/^\[(.+)\](:\d+)?$/);
  if (bracketed) {
    ip = bracketed[1];
  }

  // Zone index, e.g. "fe80::1%eth0"
  ip = ip.replace(/%.*$/, "");

  return ip || null;
};

const SINGLE_VALUE_HEADERS = [
  "x-client-ip",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "x-cluster-client-ip",
];

// Azure App Service puts its own front end in front of the container, so req.ip
// lands on an internal 10.x address and the caller sits further up the chain.
//
// X-Forwarded-For is read right to left. Each hop appends what it saw, and
// Azure appends to whatever the caller sent rather than replacing it, so the
// rightmost entries are observed and anything a caller made up stays to their
// left. Taking the first public address from the right therefore skips the
// internal hops without ever reaching a forged entry, and needs no count of how
// many proxies are in front. req.ip comes last for the same reason: with
// TRUST_PROXY set to "true" it would be the leftmost, caller-supplied entry.
const candidateIPs = (req) => {
  const headers = req.headers || {};
  const candidates = [];

  const forwarded = headers["x-forwarded-for"];
  if (forwarded) {
    candidates.push(...String(forwarded).split(",").map((part) => part.trim()).reverse());
  }

  for (const header of SINGLE_VALUE_HEADERS) {
    if (headers[header]) candidates.push(String(headers[header]).trim());
  }

  candidates.push(req.ip, req.socket?.remoteAddress);

  return candidates.map(cleanIP).filter(Boolean);
};

const getClientIP = (req) => {
  const candidates = candidateIPs(req);

  const publicIP = candidates.find((ip) => !isPrivateIP(ip));
  if (publicIP) return publicIP;

  if (candidates.length) return candidates[0];

  console.warn("Warning: Could not determine client IP");
  return "unknown";
};

module.exports = { getClientIP, isPrivateIP };

if (require.main === module && process.argv.includes("--selftest")) {
  const assert = require("assert");

  const makeReq = (ip, headers = {}, socket = "10.132.3.4") => ({
    ip,
    headers,
    socket: { remoteAddress: socket },
  });

  assert.strictEqual(
    getClientIP(makeReq("10.132.3.4", { "x-forwarded-for": "84.212.1.5:52344, 10.132.3.4" })),
    "84.212.1.5",
    "should look past the Azure front end"
  );

  assert.strictEqual(
    getClientIP(makeReq("1.2.3.4", { "x-forwarded-for": "1.2.3.4, 84.212.1.5, 10.132.3.4" })),
    "84.212.1.5",
    "should ignore an address the caller put in front of the observed one"
  );

  assert.strictEqual(
    getClientIP(makeReq("10.132.3.4", { "x-client-ip": "84.212.1.5" })),
    "84.212.1.5",
    "should fall back to the single-value headers when there is no forwarded chain"
  );

  assert.strictEqual(
    getClientIP(makeReq("84.212.1.5")),
    "84.212.1.5",
    "should use req.ip when the proxy configuration already resolved it"
  );

  assert.strictEqual(
    getClientIP(makeReq("::ffff:84.212.1.5")),
    "84.212.1.5",
    "should unwrap IPv4-mapped IPv6"
  );

  assert.strictEqual(
    getClientIP(makeReq("::1", { "x-forwarded-for": "[2001:db8::1]:443" })),
    "2001:db8::1",
    "should unwrap a bracketed IPv6 with a port"
  );

  assert.strictEqual(
    getClientIP(makeReq("10.132.3.4")),
    "10.132.3.4",
    "should keep a private address for the log rather than discarding it"
  );

  assert.strictEqual(
    getClientIP({ headers: {}, socket: {} }),
    "unknown",
    "should report unknown when there is nothing at all"
  );

  for (const priv of ["10.132.3.4", "172.16.0.1", "169.254.1.1", "192.168.1.1",
    "127.0.0.1", "100.64.0.1", "::1", "fd00::1", "fe80::1"]) {
    assert.ok(isPrivateIP(priv), `${priv} should be private`);
  }

  for (const pub of ["84.212.1.5", "172.32.0.1", "100.128.0.1", "2001:db8::1"]) {
    assert.ok(!isPrivateIP(pub), `${pub} should be public`);
  }

  console.log("clientip selftest passed");
}
