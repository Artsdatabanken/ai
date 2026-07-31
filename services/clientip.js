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

// Azure App Service puts its own front end in front of the container, so req.ip
// resolves to an internal 10.x address whatever trust proxy is set to. Walk
// every address the hop chain offers and take the first routable one.
const candidateIPs = (req) => {
  const headers = req.headers || {};
  const candidates = [req.ip];

  for (const header of [
    "x-forwarded-for",
    "x-real-ip",
    "x-client-ip",
    "true-client-ip",
    "cf-connecting-ip",
    "x-cluster-client-ip",
  ]) {
    const value = headers[header];
    if (value) {
      candidates.push(...String(value).split(",").map((part) => part.trim()));
    }
  }

  candidates.push(req.socket?.remoteAddress);

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
