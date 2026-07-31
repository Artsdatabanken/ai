const CountryCoder = require("@rapideditor/country-coder");
const IPCountryLookup = require("../ipCountryLookup");
const { writeErrorLog } = require("./logging");
const { getClientIP, isPrivateIP } = require("./clientip");

const ipLookup = new IPCountryLookup();
let ipLookupReady = false;

const initializeIpLookup = async () => {
  try {
    await ipLookup.initialize();
  } catch (error) {
    writeErrorLog(
      "Failed to load the GeoIP database on startup. Every request without " +
      "coordinates will be logged as country 'Unknown' until this is fixed.",
      error
    );
    throw error;
  }
  ipLookupReady = true;
  console.log("IP geolocation database loaded successfully");
};

const updateIpDatabase = async () => {
  await ipLookup.updateDatabase();
  ipLookupReady = true;
};

// Accepts "59.9" and "59,9" alike - Android sends comma decimals on
// Norwegian-locale devices. Anything that is not a plain number is rejected
// outright, so a malformed value falls through to the IP lookup instead of
// being half-parsed ("59,9" used to become 59).
const parseCoordinate = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim().replace(",", ".");
  if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

// Only a private address to go on means the proxy in front of us is not
// forwarding the caller. Report the forwarding headers once an hour so the
// chain can be read off the log instead of guessed at.
const PRIVATE_ONLY_REPORT_INTERVAL_MS = 60 * 60 * 1000;
let lastPrivateOnlyReport = 0;

const reportPrivateOnly = (req, clientIP) => {
  const now = Date.now();
  if (now - lastPrivateOnlyReport < PRIVATE_ONLY_REPORT_INTERVAL_MS) {
    return;
  }
  lastPrivateOnlyReport = now;

  const forwarding = [
    "x-forwarded-for",
    "x-real-ip",
    "x-client-ip",
    "true-client-ip",
    "cf-connecting-ip",
    "x-cluster-client-ip",
  ]
    .map((header) => `${header}=${req.headers?.[header] ?? "-"}`)
    .join(" ");

  writeErrorLog(
    `No public client IP available, only "${clientIP}". Country falls back to ` +
    `Unknown for requests without coordinates. Headers: ${forwarding} ` +
    `req.ip=${req.ip} socket=${req.socket?.remoteAddress}`
  );
};

const getCountryFromCoordinatesOrIP = (latitude, longitude, req) => {
  try {
    const lat = parseCoordinate(latitude);
    const lon = parseCoordinate(longitude);

    if (lat !== null && lon !== null) {
      const location = CountryCoder.iso1A2Code([lon, lat]);

      if (location) {
        return { country: location, detectedIP: null };
      } else {
        return { country: "Unknown", detectedIP: null };
      }
    }

    const clientIP = getClientIP(req);
    if (clientIP && clientIP !== "unknown") {
      if (isPrivateIP(clientIP)) {
        reportPrivateOnly(req, clientIP);
        return { country: "Unknown", detectedIP: clientIP };
      }

      if (!ipLookupReady) {
        return { country: "Unknown", detectedIP: clientIP };
      }

      const countryCode = ipLookup.lookupCountry(clientIP);
      if (countryCode) {
        return { country: countryCode, detectedIP: clientIP };
      } else {
        return { country: "Unknown", detectedIP: clientIP };
      }
    }

    return { country: "Unknown", detectedIP: null };
  } catch (error) {
    console.log(`Error in getCountryFromCoordinatesOrIP: ${error.message}`);
    return { country: "Unknown", detectedIP: null };
  }
};

module.exports = {
  parseCoordinate,
  initializeIpLookup,
  updateIpDatabase,
  getClientIP,
  getCountryFromCoordinatesOrIP
};
