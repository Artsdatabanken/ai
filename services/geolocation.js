const CountryCoder = require("@rapideditor/country-coder");
const IPCountryLookup = require("../ipCountryLookup");

const ipLookup = new IPCountryLookup();
let ipLookupReady = false;

const initializeIpLookup = async () => {
  await ipLookup.initialize();
  ipLookupReady = true;
  console.log("IP geolocation database loaded successfully");
};

const updateIpDatabase = async () => {
  await ipLookup.updateDatabase();
};

const isIpLookupReady = () => ipLookupReady;

const getClientIP = (req) => {
  const realIP =
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["cf-connecting-ip"] ||
    req.headers["x-client-ip"] ||
    req.headers["true-client-ip"] ||
    req.headers["x-cluster-client-ip"] ||
    req.ip ||
    req.socket?.remoteAddress;

  if (!realIP) {
    console.warn("Warning: Could not determine client IP");
    return "unknown";
  }

  const cleanIP = realIP
    .replace(/^::ffff:/, "")
    .replace(/:\d+[^:]*$/, "")
    .trim();

  return cleanIP;
};

const getCountryFromCoordinatesOrIP = (latitude, longitude, req) => {
  try {
    if (latitude && longitude) {
      const lat = parseFloat(latitude);
      const lon = parseFloat(longitude);

      if (!isNaN(lat) && !isNaN(lon)) {
        const location = CountryCoder.iso1A2Code([lon, lat]);

        if (location) {
          return { country: location, detectedIP: null };
        } else {
          return { country: "Unknown", detectedIP: null };
        }
      }
    }

    const clientIP = getClientIP(req);
    if (clientIP && clientIP !== "unknown") {
      const cleanIP = clientIP.replace(/^::ffff:/, "");

      if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|::1|localhost)/.test(cleanIP)) {
        return { country: "Unknown", detectedIP: cleanIP };
      }

      if (!ipLookupReady) {
        return { country: "Unknown", detectedIP: cleanIP };
      }

      const countryCode = ipLookup.lookupCountry(cleanIP);
      if (countryCode) {
        return { country: countryCode, detectedIP: cleanIP };
      } else {
        return { country: "Unknown", detectedIP: cleanIP };
      }
    }

    return { country: "Unknown", detectedIP: null };
  } catch (error) {
    console.log(`Error in getCountryFromCoordinatesOrIP: ${error.message}`);
    return { country: "Unknown", detectedIP: null };
  }
};

module.exports = {
  initializeIpLookup,
  updateIpDatabase,
  isIpLookupReady,
  getClientIP,
  getCountryFromCoordinatesOrIP
};
