const fs = require("fs");
const crypto = require("crypto");
const { TOKENS_FILE } = require("../config/constants");
const { writeErrorLog } = require("../services/logging");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

let validTokens = {};

const loadTokens = () => {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const rawTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));

      validTokens = {};
      let validCount = 0;

      for (const [token, data] of Object.entries(rawTokens)) {
        if (data.application && data.name) {
          if (data.enabled === undefined) {
            data.enabled = true;
          }
          validTokens[token] = data;
          validCount++;
        } else {
          console.warn(`Token ${token.substring(0, 8)}... missing required fields (application, name). Skipping.`);
        }
      }

      console.log(`Loaded ${validCount} valid tokens from ${TOKENS_FILE}`);
    } else {
      console.warn(`Tokens file ${TOKENS_FILE} not found. Creating empty tokens file.`);
      fs.writeFileSync(TOKENS_FILE, JSON.stringify({}, null, 2));
    }
  } catch (error) {
    console.error("Error loading tokens file:", error);
    validTokens = {};
  }
};

const reloadTokens = () => {
  loadTokens();
};

const saveTokens = () => {
  try {
    const authDir = "./auth";
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    fs.writeFileSync(TOKENS_FILE, JSON.stringify(validTokens, null, 2));
    return true;
  } catch (error) {
    console.error("Error saving tokens file:", error);
    return false;
  }
};

const generateSecureToken = () => {
  return crypto.randomBytes(32).toString("hex");
};

const getValidTokens = () => validTokens;

const authenticateAdminToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    writeErrorLog("Authentication failed: No token provided", `IP ${req.ip}`);
    return res.status(401).json({
      error: "Access denied. No token provided.",
      message: "Please include a valid Bearer token in the Authorization header."
    });
  }

  if (token === ADMIN_TOKEN) {
    req.auth = { type: "admin", token: token, application: "admin" };
    return next();
  }

  writeErrorLog("Authentication failed: Invalid admin token", `IP ${req.ip}, Token: ${token.substring(0, 10)}...`);
  return res.status(403).json({
    error: "Invalid token.",
    message: "The provided token is invalid or you do not have sufficient permissions."
  });
};

const authenticateApiToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    writeErrorLog("Authentication failed: No token provided", `IP ${req.ip}`);
    return res.status(401).json({
      error: "Access denied. No token provided.",
      message: "Please include a valid Bearer token in the Authorization header."
    });
  }

  if (token === ADMIN_TOKEN) {
    req.auth = { type: "admin", token: token, application: "admin" };
    return next();
  }

  if (validTokens?.[token]?.enabled === true) {
    req.auth = {
      type: "api",
      token: token,
      name: validTokens[token].name,
      application: validTokens[token].application
    };
    return next();
  }

  writeErrorLog("Authentication failed: Invalid token", `IP ${req.ip}, Token: ${token.substring(0, 10)}...`);
  return res.status(403).json({
    error: "Invalid token.",
    message: "The provided token is invalid."
  });
};

if (!ADMIN_TOKEN) {
  console.warn("WARNING: No ADMIN_TOKEN set. Admin functionality will be disabled.");
}

loadTokens();

module.exports = {
  loadTokens,
  reloadTokens,
  saveTokens,
  generateSecureToken,
  getValidTokens,
  authenticateAdminToken,
  authenticateApiToken
};
