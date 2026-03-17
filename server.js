const fs = require("fs");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config({ path: "./config/config.env", quiet: true });
dotenv.config({ path: "./auth/secrets.env", quiet: true });

const { taxadir, logdir, uploadsdir } = require("./config/constants");
const { writeErrorLog } = require("./services/logging");

process.on("uncaughtException", (error) => {
  writeErrorLog("Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  writeErrorLog("Unhandled rejection", reason);
});

const { initializeIpLookup } = require("./services/geolocation");
const { setupCronJobs } = require("./jobs/cron");

const identifyRoutes = require("./routes/identify");
const adminRoutes = require("./routes/admin");
const taxonRoutes = require("./routes/taxon");
const miscRoutes = require("./routes/misc");

let appInsights = require("applicationinsights");
const { SpanKind } = require("@opentelemetry/api");

class FilterHealthCheckProcessor {
  onStart() {}
  onEnd(span) {
    if (
      span.kind === SpanKind.SERVER &&
      span.name === "GET /" &&
      span.status && span.status.code !== 2
    ) {
      span.attributes["_filtered"] = true;
    }
  }
  shutdown() { return Promise.resolve(); }
  forceFlush() { return Promise.resolve(); }
}

if (process.env.IKEY) {
  appInsights.setup(process.env.IKEY).start();
  const { trace } = require("@opentelemetry/api");
  const provider = trace.getTracerProvider();
  if (provider && typeof provider.addSpanProcessor === "function") {
    provider.addSpanProcessor(new FilterHealthCheckProcessor());
  }
}

if (!fs.existsSync(taxadir)) {
  fs.mkdirSync(taxadir, { recursive: true });
}

if (!fs.existsSync(logdir)) {
  fs.mkdirSync(logdir);
}

if (!fs.existsSync(uploadsdir)) {
  fs.mkdirSync(uploadsdir);
}

const app = express();
const port = process.env.PORT;

const trustProxyConfig = process.env.TRUST_PROXY || "1";
if (trustProxyConfig === "false") {
  app.set("trust proxy", false);
} else if (/^\d+$/.test(trustProxyConfig)) {
  app.set("trust proxy", parseInt(trustProxyConfig));
} else {
  app.set("trust proxy", trustProxyConfig);
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

var corsOptions = {
  origin: "*",
};

app.use(cors(corsOptions));

app.use(function (req, res, next) {
  if (req.secure) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }
  next();
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 20 * 1024 * 1024, files: 5 } });

identifyRoutes(app, upload);
adminRoutes(app, upload);
taxonRoutes(app);
miscRoutes(app, upload);

setupCronJobs();

initializeIpLookup()
  .then(() => {
    app.listen(port, () => console.log(`Server now running on port ${port}`));
  })
  .catch((error) => {
    console.error("Failed to initialize IP lookup database:", error);
    app.listen(port, () =>
      console.log(`Server running on port ${port} (IP geolocation unavailable)`)
    );
  });
