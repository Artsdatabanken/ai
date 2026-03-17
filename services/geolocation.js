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

  let cleanIP = realIP.replace(/^::ffff:/, "").trim();
  if (cleanIP.includes(".") && !cleanIP.includes(":")) {
    cleanIP = cleanIP.replace(/:\d+$/, "");
  }

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
      if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|::1|localhost)/.test(clientIP)) {
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
  initializeIpLookup,
  updateIpDatabase,
  getClientIP,
  getCountryFromCoordinatesOrIP
};
