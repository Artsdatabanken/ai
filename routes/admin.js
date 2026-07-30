const fs = require("fs");
const path = require("path");
const { authLimiter, adminLimiter } = require("../middleware/rateLimiters");
const {
  authenticateAdminToken,
  getValidTokens,
  reloadTokens,
  saveTokens,
  generateSecureToken
} = require("../middleware/auth");
const { writeErrorLog, writeAdminLog } = require("../services/logging");
const { watchBucket, unwatchBucket, listWatched } = require("../services/ipbucket");
const { taxadir } = require("../services/taxon");
const { logdir, VALID_MODELS } = require("../config/constants");

const findTokens = (validTokens, prefix) =>
  Object.keys(validTokens).filter(
    (token) => token.startsWith(prefix) || token.substring(0, 8) === prefix
  );

module.exports = (app, upload) => {
  app.get("/admin/tokens", authLimiter, authenticateAdminToken, (req, res) => {
    try {
      const validTokens = getValidTokens();
      const tokenList = Object.keys(validTokens).map((token) => {
        const tokenInfo = {
          token: token.substring(0, 8) + "...",
          name: validTokens[token].name,
          application: validTokens[token].application,
          enabled: validTokens[token].enabled,
          created: validTokens[token].created,
          signingRequired: !!validTokens[token].secret,
          previousSecretAccepted: !!validTokens[token].previousSecret,
        };
        if (validTokens[token].model) {
          tokenInfo.model = validTokens[token].model;
        }
        return tokenInfo;
      });
      res.status(200).json({
        count: tokenList.length,
        tokens: tokenList,
      });
    } catch (error) {
      writeErrorLog("Error listing tokens", error);
      res.status(500).json({ error: "Unable to list tokens" });
    }
  });

  app.get("/admin/tokens/reload", authLimiter, authenticateAdminToken, (req, res) => {
    try {
      reloadTokens();
      const validTokens = getValidTokens();
      res.status(200).json({
        message: "Tokens reloaded successfully",
        count: Object.keys(validTokens).length,
      });
    } catch (error) {
      writeErrorLog("Error reloading tokens", error);
      res.status(500).json({ error: "Unable to reload tokens" });
    }
  });

  app.post("/admin/tokens", authLimiter, authenticateAdminToken, (req, res) => {
    try {
      const { name, application, description, model } = req.body;

      if (!name || !application) {
        return res.status(400).json({
          error: "Bad request",
          message: "name and application are required fields",
        });
      }

      if (model && !VALID_MODELS.includes(model)) {
        return res.status(400).json({
          error: "Bad request",
          message: `Invalid model. Valid options: ${VALID_MODELS.join(', ')}`,
        });
      }

      const newToken = generateSecureToken();
      const validTokens = getValidTokens();

      const tokenData = {
        name: name.trim(),
        application: application.trim(),
        enabled: true,
        created: new Date().toISOString(),
        description: description ? description.trim() : `Token for ${name}`,
        secret: generateSecureToken(),
        secretUpdated: new Date().toISOString(),
      };

      if (model) {
        tokenData.model = model;
      }

      validTokens[newToken] = tokenData;

      if (!saveTokens()) {
        return res.status(500).json({
          error: "Unable to save token to file",
        });
      }

      const response = {
        message: "Token created successfully",
        token: newToken,
        secret: tokenData.secret,
        name: tokenData.name,
        application: tokenData.application,
        enabled: tokenData.enabled,
        created: tokenData.created,
        warning:
          "Store the token and secret securely. Neither will be shown again. " +
          "Requests with this token must be signed.",
      };

      if (model) {
        response.model = model;
      }

      res.status(201).json(response);

      writeAdminLog(
        `Token created`,
        `Name: ${name}, Application: ${application}, Admin IP: ${req.ip}`
      );
    } catch (error) {
      writeErrorLog("Error creating token", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to create token",
      });
    }
  });

  app.get("/admin/ipwatch", authLimiter, authenticateAdminToken, (req, res) => {
    res.status(200).json({ buckets: listWatched() });
  });

  app.post("/admin/ipwatch/:bucket", authLimiter, authenticateAdminToken, (req, res) => {
    const bucket = String(req.params.bucket).toLowerCase();

    if (!/^[0-9a-f]{4}$/.test(bucket)) {
      return res.status(400).json({
        error: "Bad request",
        message: "A bucket is four hexadecimal characters",
      });
    }

    watchBucket(bucket);
    res.status(200).json({
      message: `Watching bucket ${bucket}. Full addresses go to ipwatch-${bucket}_<date>.csv until you stop.`,
      buckets: listWatched(),
    });

    writeAdminLog("IP bucket watch started", `Bucket: ${bucket}, Admin IP: ${req.ip}`);
  });

  app.delete("/admin/ipwatch/:bucket", authLimiter, authenticateAdminToken, (req, res) => {
    const bucket = String(req.params.bucket).toLowerCase();
    const removed = unwatchBucket(bucket);

    res.status(200).json({
      message: removed ? `Stopped watching bucket ${bucket}` : `Bucket ${bucket} was not being watched`,
      buckets: listWatched(),
    });

    if (removed) {
      writeAdminLog("IP bucket watch stopped", `Bucket: ${bucket}, Admin IP: ${req.ip}`);
    }
  });

  app.post("/admin/tokens/:tokenPrefix/secret", authLimiter, authenticateAdminToken, (req, res) => {
    try {
      const validTokens = getValidTokens();
      const found = findTokens(validTokens, req.params.tokenPrefix);

      if (found.length === 0) {
        return res.status(404).json({ error: "Token not found" });
      }
      if (found.length > 1) {
        return res.status(400).json({
          error: "Ambiguous token prefix",
          message: `${found.length} tokens start with that prefix`,
        });
      }

      const fullToken = found[0];
      const tokenData = validTokens[fullToken];
      const replaced = tokenData.secret;

      tokenData.secret = generateSecureToken();
      tokenData.secretUpdated = new Date().toISOString();
      if (replaced) {
        tokenData.previousSecret = replaced;
      }

      if (!saveTokens()) {
        return res.status(500).json({ error: "Unable to save token to file" });
      }

      res.status(200).json({
        message: replaced
          ? "Secret rotated. The previous secret stays valid until retired."
          : "Secret created. Requests with this token must be signed from now on.",
        token: fullToken.substring(0, 8) + "...",
        name: tokenData.name,
        application: tokenData.application,
        secret: tokenData.secret,
        previousSecretAccepted: !!replaced,
        warning: "Store this secret securely. It will not be shown again.",
      });

      writeAdminLog(
        replaced ? "Token secret rotated" : "Token secret created",
        `Name: ${tokenData.name}, Application: ${tokenData.application}, Admin IP: ${req.ip}`
      );
    } catch (error) {
      writeErrorLog("Error rotating token secret", error);
      res.status(500).json({ error: "Unable to rotate token secret" });
    }
  });

  app.delete("/admin/tokens/:tokenPrefix/secret/previous", authLimiter, authenticateAdminToken, (req, res) => {
    try {
      const validTokens = getValidTokens();
      const found = findTokens(validTokens, req.params.tokenPrefix);

      if (found.length === 0) {
        return res.status(404).json({ error: "Token not found" });
      }
      if (found.length > 1) {
        return res.status(400).json({
          error: "Ambiguous token prefix",
          message: `${found.length} tokens start with that prefix`,
        });
      }

      const fullToken = found[0];
      const tokenData = validTokens[fullToken];

      if (!tokenData.previousSecret) {
        return res.status(200).json({
          message: "No previous secret to retire",
          token: fullToken.substring(0, 8) + "...",
          name: tokenData.name,
        });
      }

      delete tokenData.previousSecret;

      if (!saveTokens()) {
        return res.status(500).json({ error: "Unable to save token to file" });
      }

      res.status(200).json({
        message: "Previous secret retired. Only the current secret is accepted now.",
        token: fullToken.substring(0, 8) + "...",
        name: tokenData.name,
        application: tokenData.application,
      });

      writeAdminLog(
        "Token previous secret retired",
        `Name: ${tokenData.name}, Application: ${tokenData.application}, Admin IP: ${req.ip}`
      );
    } catch (error) {
      writeErrorLog("Error retiring previous token secret", error);
      res.status(500).json({ error: "Unable to retire previous token secret" });
    }
  });

  app.patch("/admin/tokens/:tokenPrefix/enable", authLimiter, authenticateAdminToken, (req, res) => {
    try {
      const tokenPrefix = req.params.tokenPrefix;
      const validTokens = getValidTokens();

      const fullToken = Object.keys(validTokens).find(
        (token) =>
          token.startsWith(tokenPrefix) || token.substring(0, 8) === tokenPrefix
      );

      if (!fullToken || !validTokens[fullToken]) {
        return res.status(404).json({
          error: "Token not found",
          message: "No token found matching the provided prefix",
        });
      }

      validTokens[fullToken].enabled = true;

      if (!saveTokens()) {
        return res.status(500).json({
          error: "Unable to save token changes to file",
        });
      }

      res.status(200).json({
        message: "Token enabled successfully",
        token: fullToken.substring(0, 8) + "...",
        name: validTokens[fullToken].name,
        application: validTokens[fullToken].application,
        enabled: true,
      });

      writeAdminLog(
        `Token enabled`,
        `Token: ${fullToken.substring(0, 8)}..., Admin IP: ${req.ip}`
      );
    } catch (error) {
      writeErrorLog("Error enabling token", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to enable token",
      });
    }
  });

  app.patch("/admin/tokens/:tokenPrefix/disable", authLimiter, authenticateAdminToken, (req, res) => {
    try {
      const tokenPrefix = req.params.tokenPrefix;
      const validTokens = getValidTokens();

      const fullToken = Object.keys(validTokens).find(
        (token) =>
          token.startsWith(tokenPrefix) || token.substring(0, 8) === tokenPrefix
      );

      if (!fullToken || !validTokens[fullToken]) {
        return res.status(404).json({
          error: "Token not found",
          message: "No token found matching the provided prefix",
        });
      }

      validTokens[fullToken].enabled = false;

      if (!saveTokens()) {
        return res.status(500).json({
          error: "Unable to save token changes to file",
        });
      }

      res.status(200).json({
        message: "Token disabled successfully",
        token: fullToken.substring(0, 8) + "...",
        name: validTokens[fullToken].name,
        application: validTokens[fullToken].application,
        enabled: false,
      });

      writeAdminLog(
        `Token disabled`,
        `Token: ${fullToken.substring(0, 8)}..., Admin IP: ${req.ip}`
      );
    } catch (error) {
      writeErrorLog("Error disabling token", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to disable token",
      });
    }
  });

  app.delete("/admin/taxon/cache", authLimiter, authenticateAdminToken, async (req, res) => {
    try {
      let deletedCount = 0;
      let errorCount = 0;

      const files = fs.readdirSync(taxadir);

      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = `${taxadir}/${file}`;
          try {
            fs.unlinkSync(filePath);
            deletedCount++;
          } catch (error) {
            errorCount++;
            writeErrorLog(`Failed to delete cached taxon file ${file}`, error);
          }
        }
      }

      const message = `Cleared ${deletedCount} cached taxa files${
        errorCount > 0 ? ` (${errorCount} errors)` : ""
      }`;
      writeAdminLog(message, `Admin IP: ${req.ip}`);

      res.status(200).json({
        message: message,
        deleted: deletedCount,
        errors: errorCount,
        totalFiles: files.length,
      });
    } catch (error) {
      writeErrorLog("Error clearing taxa cache", error);
      res.status(500).json({
        error: "Failed to clear taxa cache",
        message: error.message,
      });
    }
  });

  app.post("/admin/rss", authLimiter, authenticateAdminToken, upload.single("rss"), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No RSS file provided" });
      }
      fs.writeFileSync("./cache/feed.rss", req.file.buffer);
      res.status(200).json({ message: "RSS feed updated successfully" });
    } catch (error) {
      console.error("Error updating RSS feed:", error);
      res.status(500).json({ error: "Failed to update RSS feed" });
    }
  });

  app.get("/admin/logs", adminLimiter, authenticateAdminToken, (req, res) => {
    try {
      var json = [];
      fs.readdir(logdir, function (err, files) {
        if (err) {
          writeErrorLog(`Error reading log directory`, err);
          return res.status(500).json({ error: "Failed to read log directory" });
        }
        files.forEach(function (file, index) {
          json.push(file);
        });
        res.status(200).json(json);
      });
    } catch (error) {
      writeErrorLog(`Error in loglist endpoint`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/admin/logs/*splat", adminLimiter, authenticateAdminToken, (req, res) => {
    try {
      let filename = decodeURI(req.originalUrl.replace("/admin/logs/", ""));
      const resolvedPath = path.resolve(logdir, filename);
      const resolvedLogdir = path.resolve(logdir);

      if (!resolvedPath.startsWith(resolvedLogdir + path.sep)) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (fs.existsSync(resolvedPath)) {
        res.download(resolvedPath);
      } else {
        res.status(404).json({ error: "File not found" });
      }
    } catch (error) {
      writeErrorLog(`Error in getlog endpoint`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
};
