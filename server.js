const fs = require("fs");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config({ path: "./config/config.env", quiet: true });
dotenv.config({ path: "./auth/secrets.env", quiet: true });

const {
  logdir,
  uploadsdir,
  cachedir,
  taxadir,
  cacheIsPersistent,
  preferredCacheDir
} = require("./config/constants");
const { writeErrorLog, reconcileLogHeaders } = require("./services/logging");

process.on("uncaughtException", (error) => {
  writeErrorLog("Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  writeErrorLog("Unhandled rejection", reason);
});

const { initializeIpLookup } = require("./services/geolocation");
const { reloadTaxonImages, refreshListVersions } = require("./services/taxon");
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

const ensureDir = (dir) => {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (error) {
    console.warn(`Could not create directory "${dir}": ${error.message}`);
  }
};

ensureDir(logdir);
ensureDir(uploadsdir);

const rewrittenHeaders = reconcileLogHeaders();
if (rewrittenHeaders) {
  writeErrorLog(
    `The log format changed: moved ${rewrittenHeaders} of today's log file(s) aside as ` +
    `"... (previous format).csv". Today's rows continue in a new file with the current header.`
  );
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
const upload = multer({ storage: storage, limits: { fileSize: 20 * 1024 * 1024, files: 10 } });

identifyRoutes(app, upload);
adminRoutes(app, upload);
taxonRoutes(app);
miscRoutes(app, upload);

app.use((error, req, res, next) => {
  writeErrorLog(`Unhandled request error on ${req.method} ${req.path}`, error);

  if (res.headersSent) {
    return next(error);
  }

  const status = error?.status || (error?.code?.startsWith?.("LIMIT_") ? 400 : 500);
  res.status(status).json({
    error: status === 400 ? "Bad request" : "Internal server error",
    message: error?.code === "LIMIT_FILE_SIZE"
      ? "An image exceeds the 20 MB limit"
      : error?.code === "LIMIT_FILE_COUNT"
        ? "Too many images"
        : undefined
  });
});

setupCronJobs();

if (!cacheIsPersistent) {
  writeErrorLog(
    `Cache dir "${preferredCacheDir}" is not writable` +
    (cachedir === preferredCacheDir ? "" : `, using "${cachedir}" instead`) +
    `. Nothing can be cached, so every request refetches and slow ones fall ` +
    `back to scientific names.`
  );
}

const persistenceStamp = `${cachedir}/.persistence`;

let stampAge = null;
try {
  const writtenAt = Number(fs.readFileSync(persistenceStamp, "utf8").trim());
  stampAge = ((Date.now() - writtenAt) / (1000 * 60 * 60)).toFixed(1);
} catch {}

let entries = 0;
let newestEntryAgeDays = null;
try {
  const files = fs.readdirSync(taxadir).filter((f) => f.endsWith(".json"));
  entries = files.length;
  let newest = 0;
  for (const file of files) {
    try {
      const mtime = fs.statSync(`${taxadir}/${file}`).mtimeMs;
      if (mtime > newest) newest = mtime;
    } catch {}
  }
  if (newest) {
    newestEntryAgeDays = ((Date.now() - newest) / (1000 * 60 * 60 * 24)).toFixed(1);
  }
} catch {}

writeErrorLog(
  `Startup: taxon cache "${taxadir}" holds ${entries} entries` +
  (newestEntryAgeDays === null ? "" : `, newest written ${newestEntryAgeDays} days ago`) +
  `, persistence stamp ${stampAge === null ? "missing" : `written ${stampAge}h ago`}. ` +
  (entries === 0 && stampAge === null
    ? "Nothing survived, so this is either the first start on this version or the cache is not persistent."
    : entries > 0 && stampAge === null
      ? "Entries survived without a stamp, so the cache is persistent and the stamp is simply new."
      : entries === 0
        ? "The stamp survived but the entries did not, which should not happen."
        : "Cache and stamp both survived, so storage is persistent.")
);

fs.writeFileSync(persistenceStamp, String(Date.now()));

reloadTaxonImages().catch((error) =>
  writeErrorLog("Failed to reload taxon images on startup", error)
);

refreshListVersions().catch((error) =>
  writeErrorLog("Failed to determine the published list versions on startup", error)
);

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
