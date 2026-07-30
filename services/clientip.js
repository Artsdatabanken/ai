const getClientIP = (req) => {
  const realIP = req.ip || req.socket?.remoteAddress;

  if (!realIP) {
    console.warn("Warning: Could not determine client IP");
    return "unknown";
  }

  let cleanIP = realIP.replace(/^::ffff:/, "").trim();
  const ipv4PortMatch = cleanIP.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
  if (ipv4PortMatch) {
    cleanIP = ipv4PortMatch[1];
  }

  // "[2001:db8::1]:443" - proxies bracket IPv6 when they append a port
  const ipv6BracketMatch = cleanIP.match(/^\[(.+)\](:\d+)?$/);
  if (ipv6BracketMatch) {
    cleanIP = ipv6BracketMatch[1];
  }

  // Zone index, e.g. "fe80::1%eth0"
  cleanIP = cleanIP.replace(/%.*$/, "");

  return cleanIP;
};

module.exports = { getClientIP };
