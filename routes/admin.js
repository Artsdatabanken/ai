const fs = require("fs");
const path = require("path");
const { apiLimiter, authLimiter } = require("../middleware/rateLimiters");
const {
  authenticateAdminToken,
  getValidTokens,
  reloadTokens,
  saveTokens,
  generateSecureToken
} = require("../middleware/auth");
const { writeErrorLog } = require("../services/logging");
const { taxadir } = require("../services/taxon");
const { logdir } = require("../config/constants");

module.exports = (app, upload) => {
  app.get("/admin/tokens", authLimiter, authenticateAdminToken, (req, res) => {
    try {
      const validTokens = getValidTokens();
      const tokenList = Object.keys(validTokens).map((token) => ({
        token: token.substring(0, 8) + "...",
        name: validTokens[token].name,
        application: validTokens[token].application,
        enabled: validTokens[token].enabled,
        created: validTokens[token].created,
      }));
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
      const { name, application, description } = req.body;

      if (!name || !application) {
        return res.status(400).json({
          error: "Bad request",
          message: "name and application are required fields",
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
      };

      validTokens[newToken] = tokenData;

      if (!saveTokens()) {
        return res.status(500).json({
          error: "Unable to save token to file",
        });
      }

      res.status(201).json({
        message: "Token created successfully",
        token: newToken,
        name: tokenData.name,
        application: tokenData.application,
        enabled: tokenData.enabled,
        created: tokenData.created,
        warning: "Store this token securely. It will not be shown again in full.",
      });

      writeErrorLog(
        `Token created successfully`,
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

      writeErrorLog(
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

      writeErrorLog(
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
      writeErrorLog(message, `Admin IP: ${req.ip}`);

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

  app.get("/admin/logs", authLimiter, authenticateAdminToken, (req, res) => {
    try {
      var json = [];
      fs.readdir(logdir, function (err, files) {
        if (err) {
          writeErrorLog(`Error reading log directory`, err);
          return res.status(500).end();
        }
        files.forEach(function (file, index) {
          json.push(file);
        });
        res.status(200).json(json);
      });
    } catch (error) {
      writeErrorLog(`Error in loglist endpoint`, error);
      res.status(500).end();
    }
  });

  app.get("/admin/logs/*", authLimiter, authenticateAdminToken, (req, res) => {
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
        res.status(404).end();
      }
    } catch (error) {
      writeErrorLog(`Error in getlog endpoint`, error);
      res.status(500).end();
    }
  });
};
