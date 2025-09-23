const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");
const taxonMapper = require("./taxonMapping");
const cron = require("node-cron");
const rateLimit = require("express-rate-limit");
const sanitize = require("sanitize-filename");



const getClientIP = (req) => {
  const realIP =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['cf-connecting-ip'] || // Cloudflare
    req.headers['x-client-ip'] ||
    req.headers['true-client-ip'] || // Some CDNs
    req.headers['x-cluster-client-ip'] || // Some proxies
    req.ip || // Express's processed IP (respects trust proxy setting)
    req.socket?.remoteAddress;

  if (!realIP) {
    console.warn('Warning: Could not determine client IP');
    return 'unknown';
  }

  const cleanIP = realIP
    .replace(/^::ffff:/, '')
    .replace(/:\d+[^:]*$/, '')
    .trim();

  return cleanIP;
};

const cacheLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // Timeframe
  max: 30, // Max requests per timeframe per ip
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  keyGenerator: getClientIP, // Use safe IP extraction
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many cache requests`,
      `IP ${getClientIP(request)}`
    );
    return response.status(options.statusCode).send(options.message);
  },
});

const idLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // Timeframe
  max: 9999, // Max requests per timeframe per ip
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  keyGenerator: getClientIP, // Use safe IP extraction
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many ID requests`,
      `IP ${getClientIP(request)}`
    );
    return response.status(options.statusCode).send(options.message);
  },
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // Timeframe
  max: 30, // Max requests per timeframe per ip
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  keyGenerator: getClientIP, // Use safe IP extraction
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many misc API requests`,
      `IP ${getClientIP(request)}`
    );
    return response.status(options.statusCode).send(options.message);
  },
});

const authLimiter = rateLimit({
  windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW || 15) * 60 * 1000, // Default: 15 minutes
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || 5), // Default: 5 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP, // Use safe IP extraction
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many authentication attempts`,
      `IP ${getClientIP(request)}`
    );
    return response.status(options.statusCode).json({
      error: "Too many authentication attempts. Please try again later.",
      retryAfter: Math.round(options.windowMs / 1000)
    });
  },
});

const crypto = require("crypto");
const encryption_algorithm = "aes-256-ctr";
const initVect = crypto.randomBytes(16);

const CountryCoder = require('@rapideditor/country-coder');
const IPCountryLookup = require('./ipCountryLookup');
const ipLookup = new IPCountryLookup();
let ipLookupReady = false;

let appInsights = require("applicationinsights");

dotenv.config({ path: "./config/config.env" });
dotenv.config({ path: "./config/secrets.env" });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const TOKENS_FILE = './auth/tokens.json';

let validTokens = {};
const loadTokens = () => {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const rawTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));

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
    console.error('Error loading tokens file:', error);
    validTokens = {};
  }
};

loadTokens();

if (!ADMIN_TOKEN) {
  console.warn('WARNING: No ADMIN_TOKEN set. Admin functionality will be disabled.');
}

const logdir = "./log";
const authdir = "./auth";
const cachedir = "./cache";


const taxadir = `${cachedir}/taxa`;
const pictureFile = `${cachedir}/taxonPictures.json`;
const uploadsdir = "./uploads";

var taxonPics = {};
if (fs.existsSync(pictureFile)) {
  taxonPics = JSON.parse(fs.readFileSync(pictureFile));
}

const dateStr = (resolution = `d`, date = false) => {
  if (!date) {
    date = new Date();
  }

  let iso = date
    .toLocaleString("en-CA", { timeZone: "Europe/Oslo", hour12: false })
    .replace(", ", "T");
  iso = iso.replace("T24", "T00");
  iso += "." + date.getMilliseconds().toString().padStart(3, "0");
  const lie = new Date(iso + "Z");
  const offset = -(lie - date) / 60 / 1000;

  if (resolution === `m`) {
    return `${new Date(date.getTime() - offset * 60 * 1000)
      .toISOString()
      .substring(0, 7)}`;
  } else if (resolution === `s`) {
    return `${new Date(date.getTime() - offset * 60 * 1000)
      .toISOString()
      .substring(0, 19)
      .replace("T", " ")}`;
  }

  return `${new Date(date.getTime() - offset * 60 * 1000)
    .toISOString()
    .substring(0, 10)}`;
};

const writeErrorLog = (message, error) => {
  if (!!error) {
    fs.appendFileSync(
      `${logdir}/errorlog_${dateStr(`d`)}.txt`,
      `\n${dateStr(`s`)}: ${message}\n   ${error}\n`
    );
  } else {
    fs.appendFileSync(
      `${logdir}/errorlog_${dateStr(`d`)}.txt`,
      `${dateStr(`s`)}: ${message}\n`
    );
  }
};

if (!fs.existsSync(taxadir)) {
  fs.mkdirSync(taxadir);
}

const authenticateAdminToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    writeErrorLog('Authentication failed: No token provided', `IP ${req.ip}`);
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      message: 'Please include a valid Bearer token in the Authorization header.'
    });
  }

  if (token === ADMIN_TOKEN) {
    req.auth = { type: 'admin', token: token, application: 'admin' };
    return next();
  }

  writeErrorLog('Authentication failed: Invalid admin token', `IP ${req.ip}, Token: ${token.substring(0, 10)}...`);
  return res.status(403).json({
    error: 'Invalid token.',
    message: 'The provided token is invalid or you do not have sufficient permissions.'
  });
};

const authenticateApiToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    writeErrorLog('Authentication failed: No token provided', `IP ${req.ip}`);
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      message: 'Please include a valid Bearer token in the Authorization header.'
    });
  }

  if (token === ADMIN_TOKEN) {
    req.auth = { type: 'admin', token: token, application: 'admin' };
    return next();
  }

  if (validTokens[token] && validTokens[token].enabled === true) {
    req.auth = {
      type: 'api',
      token: token,
      name: validTokens[token].name,
      application: validTokens[token].application
    };
    return next();
  }

  writeErrorLog('Authentication failed: Invalid token', `IP ${req.ip}, Token: ${token.substring(0, 10)}...`);
  return res.status(403).json({
    error: 'Invalid token.',
    message: 'The provided token is invalid.'
  });
};

const reloadTokens = () => {
  loadTokens();
};

const saveTokens = () => {
  try {
    const configDir = './config';
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(TOKENS_FILE, JSON.stringify(validTokens, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving tokens file:', error);
    return false;
  }
};

const generateSecureToken = () => {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
};

/** Filter for not logging requests for root url when success */
var filteringAiFunction = (envelope, context) => {
  if (
    envelope.data.baseData.success &&
    envelope.data.baseData.name === "GET /"
  ) {
    return false;
  }

  return true;
};

if (process.env.IKEY) {
  appInsights.setup(process.env.IKEY).start();
  appInsights.defaultClient.addTelemetryProcessor(filteringAiFunction);
}

const app = express();
const port = process.env.PORT;

const trustProxyConfig = process.env.TRUST_PROXY || '1';
if (trustProxyConfig === 'false') {
  app.set('trust proxy', false);
} else if (/^\d+$/.test(trustProxyConfig)) {
  app.set('trust proxy', parseInt(trustProxyConfig));
} else {
  app.set('trust proxy', trustProxyConfig);
}


app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

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
const upload = multer({ storage: storage });

let getPicture = (sciName) => {
  sciName = sciName.replaceAll("×", "x").replaceAll("ë", "e");

  let pic = taxonPics[sciName];
  if (pic) {
    return `https://artsdatabanken.no/Media/${pic}?mode=128x128`;
  }

  return null;
};

let writelog = (req, json, auth = null) => {
  let application;

  if (auth && auth.application) {
    application = sanitize(auth.application);
  } else if (req.body.application) {
    application = sanitize(req.body.application);
  }

  let logPrefix = application;

  if (!fs.existsSync(`${logdir}/${logPrefix}_${dateStr(`d`)}.csv`)) {
    fs.appendFileSync(
      `${logdir}/${logPrefix}_${dateStr(`d`)}.csv`,
      "Datetime," +
      "IP," +
      "Latitude," +
      "Longitude," +
      "Country," +
      "Model," +
      "Number_of_pictures," +
      "Result_1_name,Result_1_group,Result_1_probability," +
      "Result_2_name,Result_2_group,Result_2_probability," +
      "Result_3_name,Result_3_group,Result_3_probability," +
      "Result_4_name,Result_4_group,Result_4_probability," +
      "Result_5_name,Result_5_group,Result_5_probability\n"
    );
  }

  const latitude = req.body.latitude || '';
  const longitude = req.body.longitude || '';
  const country = json.modelInfo ? json.modelInfo.country : '';
  const model = json.modelInfo ? json.modelInfo.model : '';
  const clientIP = json.modelInfo && json.modelInfo.detectedIP ? json.modelInfo.detectedIP : '';

  let row = `${dateStr(`s`)},"${clientIP}","${latitude}","${longitude}","${country}","${model}",${Array.isArray(req.files) ? req.files.length : 0
    }`;

  for (let i = 0; i < json.predictions[0].taxa.items.length; i++) {
    const prediction = json.predictions[0].taxa.items[i];
    row += `,"${prediction.name}","${prediction.groupName}",${prediction.probability}`;
  }

  row += "\n";

  fs.appendFileSync(`${logdir}/${application}_${dateStr(`d`)}.csv`, row);
};

let getName = async (sciName, force = false, country = null) => {
  let unencoded_jsonfilename = `${taxadir}/${sanitize(sciName)}.json`;
  let jsonfilename = `${taxadir}/${encodeURIComponent(sciName)}.json`;

  if (
    fs.existsSync(unencoded_jsonfilename) &&
    unencoded_jsonfilename !== jsonfilename
  ) {
    fs.unlink(unencoded_jsonfilename, function (error) {
      if (error)
        writeErrorLog(
          `Could not delete "${unencoded_jsonfilename}" while updating old filename`,
          error
        );
    });
  }

  // --- Return the cached json if it exists, and it parses, and no recache is forced. In all other cases, try to delete that cache.
  if (fs.existsSync(jsonfilename)) {
    if (!force) {
      try {
        const cachedData = JSON.parse(fs.readFileSync(jsonfilename));
        if (country === 'NO') {
          if (cachedData.redListCategories && cachedData.redListCategories.NO) {
            cachedData.redListCategory = cachedData.redListCategories.NO;
          }
          if (cachedData.invasiveCategories && cachedData.invasiveCategories.NO) {
            cachedData.invasiveCategory = cachedData.invasiveCategories.NO;
          }
        }
        return cachedData;
      } catch (error) {
        writeErrorLog(`Could not parse "${jsonfilename}"`, error);

        fs.unlink(jsonfilename, function (error) {
          if (error)
            writeErrorLog(
              `Could not delete "${jsonfilename}" after JSON parse failed`,
              error
            );
        });
      }
    } else {
      fs.unlink(jsonfilename, function (error) {
        if (error)
          writeErrorLog(
            `Could not delete "${jsonfilename}" while forcing recache`,
            error
          );
      });
    }
  }

  let nameResult = {
    vernacularName: sciName,
    vernacularNames: {},
    groupName: "",
    scientificName: sciName,
    redListCategories: {},
    invasiveCategories: {},
  };
  let name;

  let retrievedTaxon = { data: [] };

  try {
    let url = encodeURI(
      `https://artsdatabanken.no/api/Resource/?Take=10&Type=taxon&Name=${sciName}`
    );
    let taxon = await axios
      .get(url, {
        timeout: 3000,
      })
      .catch((error) => {
        writeErrorLog(
          `Failed to ${!force ? "get info for" : "*recache*"
          } ${sciName} from ${url}.`,
          error
        );
        throw "";
      });

    let acceptedtaxon = taxon.data.find(
      (t) => t.Name.includes(sciName) && t.AcceptedNameUsage
    );

    if (!!acceptedtaxon) {
      retrievedTaxon.data = acceptedtaxon;

      if (acceptedtaxon.Tags && Array.isArray(acceptedtaxon.Tags)) {
        const redListCodes = ['CR', 'EN', 'VU', 'NT', 'DD', 'LC'];
        const invasiveCodes = ['NK', 'LO', 'PH', 'HI', 'SE'];

        for (const tag of acceptedtaxon.Tags) {
          if (tag.startsWith('Kategori/')) {
            const code = tag.split('/')[1];
            if (redListCodes.includes(code)) {
              nameResult.redListCategories.NO = code;
              if (country === 'NO') {
                nameResult.redListCategory = code;
              }
            } else if (invasiveCodes.includes(code)) {
              nameResult.invasiveCategories.NO = code;
              if (country === 'NO') {
                nameResult.invasiveCategory = code;
              }
            }
          }
        }
      }
    } else {
      let hit = taxon.data.find((t) =>
        t.ScientificNames.find((sn) =>
          sn.HigherClassification.find((h) => h.ScientificName === sciName)
        )
      );
      if (!hit) throw "No HigherClassification hit";
      hit = hit.ScientificNames.find((sn) =>
        sn.HigherClassification.find((h) => h.ScientificName === sciName)
      );
      hit = hit.HigherClassification.find((h) => h.ScientificName === sciName);
      hit = hit.ScientificNameId;
      url = `https://artsdatabanken.no/api/Resource/ScientificName/${hit}`;
      taxon = await axios
        .get(url, {
          timeout: 3000,
        })
        .catch((error) => {
          writeErrorLog(
            `Failed to ${!force ? "get info for" : "*recache*"
            } ${sciName} from ${url}.`,
            error
          );
          throw "";
        });

      url = `https://artsdatabanken.no/api/Resource/Taxon/${taxon.data.Taxon.TaxonId}`;
      taxon = await axios
        .get(url, {
          timeout: 3000,
        })
        .catch((error) => {
          writeErrorLog(
            `Failed to ${!force ? "get info for" : "*recache*"
            } ${sciName} from ${url}.`,
            error
          );
          throw "";
        });

      retrievedTaxon.data = taxon.data;

      if (taxon.data.Tags && Array.isArray(taxon.data.Tags)) {
        const redListCodes = ['CR', 'EN', 'VU', 'NT', 'DD', 'LC'];
        const invasiveCodes = ['NK', 'LO', 'PH', 'HI', 'SE'];

        for (const tag of taxon.data.Tags) {
          if (tag.startsWith('Kategori/')) {
            const code = tag.split('/')[1];
            if (redListCodes.includes(code)) {
              nameResult.redListCategories.NO = code;
              if (country === 'NO') {
                nameResult.redListCategory = code;
              }
            } else if (invasiveCodes.includes(code)) {
              nameResult.invasiveCategories.NO = code;
              if (country === 'NO') {
                nameResult.invasiveCategory = code;
              }
            }
          }
        }
      }
    }

    nameResult.scientificName =
      retrievedTaxon.data.AcceptedNameUsage.ScientificName;
    nameResult.scientificNameID =
      retrievedTaxon.data.AcceptedNameUsage.ScientificNameId;

    // Extract all RecommendedVernacularName fields for different languages from Artsdatabanken
    for (const [key, value] of Object.entries(retrievedTaxon.data)) {
      if (key.startsWith("RecommendedVernacularName_") && value) {
        let langCode = key.replace("RecommendedVernacularName_", "");
        langCode = langCode.split("-")[0]
        nameResult.vernacularNames[langCode] = value;
      }
    }

    // Define target languages to fetch (excluding those typically found in Artsdatabanken)
    const targetLanguages = ['sv', 'nl', 'en', 'es'];
    const missingLanguages = targetLanguages.filter(lang => !nameResult.vernacularNames[lang]);

    // If all languages are already filled, skip further fetching
    if (missingLanguages.length !== 0) {
      // Priority 1: GBIF (Catalog of Life)
      if (missingLanguages.length > 0) {
        try {
          const gbifUrl = encodeURI(`https://api.gbif.org/v1/species/search?datasetKey=7ddf754f-d193-4cc9-b351-99906754a03b&nameType=SCIENTIFIC&q=${nameResult.scientificName}`);
          const gbifResponse = await axios
            .get(gbifUrl, { timeout: 3000 })
            .catch((error) => {
              console.log(`Failed to get GBIF names for ${nameResult.scientificName}:`, error.message);
              return null;
            });

          if (gbifResponse && gbifResponse.data && gbifResponse.data.results && Array.isArray(gbifResponse.data.results)) {
            const matchingResults = gbifResponse.data.results.filter(
              item => item.canonicalName &&
                item.canonicalName.toLowerCase() === nameResult.scientificName.toLowerCase() &&
                item.vernacularNames && item.vernacularNames.length > 0
            );

            const languageMap = {
              'swe': 'sv',
              'eng': 'en',
              'nld': 'nl',
              'spa': 'es'
            };

            for (const result of matchingResults) {
              if (result.vernacularNames && Array.isArray(result.vernacularNames)) {
                for (const [threeLetterCode, twoLetterCode] of Object.entries(languageMap)) {
                  if (!nameResult.vernacularNames[twoLetterCode]) {
                    const nameEntry = result.vernacularNames.find(
                      vn => vn.language === threeLetterCode && vn.vernacularName
                    );
                    if (nameEntry && nameEntry.vernacularName) {
                      nameResult.vernacularNames[twoLetterCode] = nameEntry.vernacularName;
                    }
                  }
                }
              }
            }
          }
        } catch (error) {
          console.log(`Error fetching GBIF names for ${nameResult.scientificName}:`, error.message);
        }
      }

      // Priority 2: Artdatabanken.se (Swedish)
      if (!nameResult.vernacularNames.sv) {
        try {
          const swedishUrl = encodeURI(`https://nos-api.artdatabanken.se/api/search?searchType=exact&search=${nameResult.scientificName}`);
          const swedishResponse = await axios
            .get(swedishUrl, { timeout: 3000 })
            .catch((error) => {
              console.log(`Failed to get Swedish name for ${nameResult.scientificName}:`, error.message);
              return null;
            });

          if (swedishResponse && swedishResponse.data && Array.isArray(swedishResponse.data)) {
            const matchingTaxon = swedishResponse.data.find(
              item => item.scientificName &&
                item.scientificName.toLowerCase() === nameResult.scientificName.toLowerCase() &&
                item.swedishName
            );

            if (matchingTaxon && matchingTaxon.swedishName) {
              nameResult.vernacularNames.sv = matchingTaxon.swedishName;
            }
          }
        } catch (error) {
          console.log(`Error fetching Swedish name for ${nameResult.scientificName}:`, error.message);
        }
      }

      // Priority 3: Wikipedia
      const remainingLangs = targetLanguages.filter(lang => !nameResult.vernacularNames[lang]);
      if (remainingLangs.length > 0) {
        try {
          const wikiSpeciesUrl = encodeURI(`https://api.wikimedia.org/core/v1/wikispecies/page/${nameResult.scientificName.replace(' ', '_')}/links/language`);
          const wikiResponse = await axios
            .get(wikiSpeciesUrl, { timeout: 3000 })
            .catch((error) => {
              console.log(`Failed to get Wikipedia names for ${nameResult.scientificName}:`, error.message);
              return null;
            });

          if (wikiResponse && wikiResponse.data && Array.isArray(wikiResponse.data)) {
            for (const link of wikiResponse.data) {
              if (remainingLangs.includes(link.code) && !nameResult.vernacularNames[link.code]) {
                // Remove parentheses and their contents from the title
                let cleanTitle = link.title.replace(/\s*\([^)]*\)/g, '').trim();
                if (cleanTitle && cleanTitle !== nameResult.scientificName) {
                  nameResult.vernacularNames[link.code] = cleanTitle;
                }
              }
            }
          }
        } catch (error) {
          console.log(`Error fetching Wikipedia names for ${nameResult.scientificName}:`, error.message);
        }
      }

      // Priority 4: iNaturalist
      const stillMissingLangs = targetLanguages.filter(lang => !nameResult.vernacularNames[lang]);
      if (stillMissingLangs.length > 0) {
        for (const lang of stillMissingLangs) {
          try {
            const iNatUrl = encodeURI(`https://api.inaturalist.org/v1/taxa/autocomplete?q=${nameResult.scientificName.replace(' ', '+')}&per_page=1&locale=${lang}`);
            const iNatResponse = await axios
              .get(iNatUrl, { timeout: 3000 })
              .catch((error) => {
                console.log(`Failed to get iNaturalist ${lang} name for ${nameResult.scientificName}:`, error.message);
                return null;
              });

            if (iNatResponse && iNatResponse.data && iNatResponse.data.results && Array.isArray(iNatResponse.data.results)) {
              const result = iNatResponse.data.results.find(
                item => item.name &&
                  item.name.toLowerCase() === nameResult.scientificName.toLowerCase() &&
                  item.preferred_common_name
              );

              if (result && result.preferred_common_name) {
                nameResult.vernacularNames[lang] = result.preferred_common_name;
              }
            }
          } catch (error) {
            console.log(`Error fetching iNaturalist ${lang} name for ${nameResult.scientificName}:`, error.message);
          }
        }
      }
    }

    // Set the default vernacularName for backward compatibility
    nameResult.vernacularName =
      nameResult.vernacularNames.nb ||
      nameResult.vernacularNames.nn ||
      nameResult.vernacularNames.en ||
      nameResult.scientificName ||
      sciName;

    if (retrievedTaxon.data.Description) {
      const description =
        retrievedTaxon.data.Description.find(
          (desc) =>
            desc.Language == "nb" ||
            desc.Language == "no" ||
            desc.Language == "nn"
        ) || retrievedTaxon.data.Description[0];

      nameResult.infoUrl = description.Id.replace(
        "Nodes/",
        "https://artsdatabanken.no/Pages/"
      );
    } else {
      nameResult.infoUrl =
        "https://artsdatabanken.no/" + retrievedTaxon.data.Id;
    }

    url = encodeURI(`https://artsdatabanken.no/Api/${retrievedTaxon.data.Id}`);
    name = await axios
      .get(url, {
        timeout: 3000,
      })
      .catch((error) => {
        writeErrorLog(
          `Failed to ${!force ? "get info for" : "*recache*"
          } ${sciName} from ${url}.`,
          error
        );
        throw "";
      });
  } catch (error) {
    writeErrorLog(
      `Error in getName(${sciName}). Retry: ${encodeURI(
        "https://ai.test.artsdatabanken.no/cachetaxon/" + sciName
      )}.`,
      error
    );
    return nameResult;
  }

  if (name && name.data.AcceptedName.dynamicProperties) {
    let artsobsname = name.data.AcceptedName.dynamicProperties.find(
      (dp) =>
        dp.Name === "GruppeNavn" &&
        dp.Properties.find((p) => p.Value === "Artsobservasjoner")
    );

    if (artsobsname && artsobsname.Value) {
      nameResult.groupName = artsobsname.Value;
    }
  }

  if (force || !fs.existsSync(jsonfilename)) {
    let data = JSON.stringify(nameResult);
    fs.writeFileSync(jsonfilename, data);
  }

  return nameResult;
};

// Check if there are old files to be deleted every X minute:
cron.schedule("30 * * * *", () => {
  //console.log('Running cleanup every 30th minute');

  // Loop over all files in uploads/
  fs.readdir(`${uploadsdir}/`, (err, files) => {
    if (files) {
      files.forEach((file) => {
        // gets timestamp from filename
        let filename = file.split("_")[1];
        // gets current timestamp
        let timestamp = Math.round(new Date().getTime() / 1000);
        // Check timestamp vs. time now
        let time_between = timestamp - filename;
        // Image Survival length, if change this - ensure to change in artsobs-mobile too...
        let survival_length = 3600; // 1 hr in seconds
        // If more than survival_length
        if (time_between >= survival_length) {
          // Delete the file
          fs.unlink(`${uploadsdir}/${file}`, (err) => {
            if (err) {
              console.log("could not delete file");
            }
            console.log("The file has been deleted!");
          });
        }
      });
    }
  });
});

// Update GeoIP database weekly (every Sunday at 3 AM)
cron.schedule("0 3 * * 0", async () => {
  console.log('Running weekly GeoIP database update...');
  try {
    await ipLookup.updateDatabase();
    console.log('GeoIP database update completed');
  } catch (error) {
    writeErrorLog('Failed to update GeoIP database', error);
  }
});

function encrypt(file, password) {
  // Create a new cipher using the algorithm, key, and initVect
  const cipher = crypto.createCipheriv(
    encryption_algorithm,
    password,
    initVect
  );
  // file is already a string - base64
  const encrypted = Buffer.concat([cipher.update(file), cipher.final()]);
  return encrypted;
}

const decrypt = (encrypted_content, password) => {
  // Use the same things to create the decipher vector
  const decipher = crypto.createDecipheriv(
    encryption_algorithm,
    password,
    initVect
  );
  // Apply the deciphering
  const decrypted = Buffer.concat([
    decipher.update(encrypted_content),
    decipher.final(),
  ]);
  return decrypted.toString();
};

function makeRandomHash() {
  // TODO check that this is not used. To do this, loop over uploads folder
  // It would be shocking if it is used considering we use the current date as input, and
  // clean out images every 30 minutes. But you never know.
  let current_date = new Date().valueOf().toString();
  let random = Math.random().toString();
  return crypto
    .createHash("sha1")
    .update(current_date + random)
    .digest("hex");
}

let saveImagesAndGetToken = async (req) => {
  // Create random, unused id & password, password must be a certain length
  let id = makeRandomHash();
  let password = makeRandomHash().substring(0, 32);
  let counter = 0;

  for (let image of req.files) {
    let timestamp = Math.round(new Date().getTime() / 1000);

    // Turn image into base64 to allow both encryption and future transfer
    let base64image = image.buffer.toString("base64");

    // Perform encryption
    let encrypted_file = encrypt(base64image, password);

    // Save encrypted file to disk and put id & date (unix timestamp) in filename
    let filename = id + "_" + counter + "_" + timestamp + "_";

    // ensure uniqueness in case the other factors end up the same (unlikely)
    counter += 1;

    // Upload to uploads folder
    fs.writeFile(`${uploadsdir}/${filename}`, encrypted_file, (error) => {
      if (error) {
        writeErrorLog(
          `Failed to write file "${uploadsdir}/${filename}".`,
          error
        );
      }
      console.log("The file has been saved!");
    });
  }
  return { id: id, password: password };
};

let simplifyJson = (json) => {
  if (json.predictions[0].taxa) {
    json.predictions = json.predictions[0].taxa.items.map((p) => {
      let simplified = {
        probability: p.probability,
        taxon: p,
      };
      simplified.taxon.probability = undefined;
      return simplified;
    });
  }

  return json;
};

let refreshtaxonimages = async () => {
  const pages = [342548, 342550, 342551, 342552, 342553, 342554];
  let taxa = {};

  for (let index = 0; index < pages.length; index++) {
    let pageId = pages[index];
    let url = encodeURI(`https://www.artsdatabanken.no/api/Content/${pageId}`);
    let page = await axios
      .get(url, {
        timeout: 10000,
      })
      .catch((error) => {
        writeErrorLog(
          `Error getting "${url}" while running refreshtaxonimages`,
          error
        );
        throw "";
      });

    if (!!page) {
      page.data.Files.forEach((f) => {
        // Unpublished files have no FileUrl
        if (f.FileUrl) {
          let name = f.Title.split(".")[0].replaceAll("_", " ");
          let value = f.Id.split("/")[1];
          taxa[name] = value;
        }
      });
    }
  }

  taxonPics = taxa;
  fs.writeFileSync(pictureFile, JSON.stringify(taxa));
  return Object.keys(taxa).length;
};

const getCountryFromCoordinatesOrIP = (latitude, longitude, req) => {
  try {
    if (latitude && longitude) {
      const lat = parseFloat(latitude);
      const lon = parseFloat(longitude);

      if (!isNaN(lat) && !isNaN(lon)) {
        // Use country-coder for accurate country detection
        const location = CountryCoder.iso1A2Code([lon, lat]);

        if (location) {
          return { country: location, detectedIP: null };
        } else {
          return { country: 'Unknown', detectedIP: null };
        }
      }
    }

    // Get client IP
    const clientIP = getClientIP(req);
    if (clientIP && clientIP !== 'unknown') {
      const cleanIP = clientIP.replace(/^::ffff:/, '');

      // Check if it's a private IP
      if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|::1|localhost)/.test(cleanIP)) {
        return { country: 'Unknown', detectedIP: cleanIP };
      }

      // Look up country from IP
      if (!ipLookupReady) {
        return { country: 'Unknown', detectedIP: cleanIP };
      }

      const countryCode = ipLookup.lookupCountry(cleanIP);
      if (countryCode) {
        return { country: countryCode, detectedIP: cleanIP };
      } else {
        return { country: 'Unknown', detectedIP: cleanIP };
      }
    }

    return { country: 'Unknown', detectedIP: null };
  } catch (error) {
    console.log(`Error in getCountryFromCoordinatesOrIP: ${error.message}`);
    return { country: 'Unknown', detectedIP: null };
  }
};

let getId = async (req) => {
  try {
    const form = new FormData();
    const formHeaders = form.getHeaders();
    const receivedParams = Object.keys(req.body);

    receivedParams.forEach((key, index) => {
      form.append(key, req.body[key]);
    });

    var stream = require("stream");

    for (const file of req.files) {
      var bufferStream = new stream.PassThrough();
      bufferStream.end(file.buffer);
      form.append("image", bufferStream, {
        filename: "" + Date.now() + "." + file.mimetype.split("image/").pop(),
      });
    }

    // Determine country for model selection
    const geoResult = getCountryFromCoordinatesOrIP(
      req.body.latitude,
      req.body.longitude,
      req
    );
    const country = geoResult.country;
    const detectedIP = geoResult.detectedIP;

    // Determine location source for response
    let locationSource = 'unknown';
    if (req.body.latitude && req.body.longitude) {
      locationSource = 'coordinates';
    } else if (country !== 'Unknown') {
      locationSource = 'ip';
    }

    let token;
    let modelUsed;

    // Check if user explicitly requested global model
    if (receivedParams.includes('model') && req.body.model && req.body.model.toLowerCase() === "global") {
      token = process.env.SH_TOKEN; // Global/European model
      modelUsed = 'European';
    } else if (country === 'NO' || country === 'Unknown') {
      // Use Norwegian model for Norway, and assume Norway if country is unknown
      token = process.env.SP_TOKEN; // Specialized (Norwegian) token
      modelUsed = 'Norwegian';
    } else {
      // Use global model for all other countries
      token = process.env.SH_TOKEN; // Global/European model
      modelUsed = 'European';
    }

    let recognition;

    recognition = await axios
      .post(
        `https://multi-source.identify.biodiversityanalysis.eu/v2/observation/identify/token/${token}`,
        form,
        {
          headers: {
            ...formHeaders,
          },
          auth: {
            username: process.env.NATURALIS_USERNAME,
            password: process.env.NATURALIS_PASSWORD,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      )
      .catch((error) => {
        writeErrorLog(
          `Naturalis API v2 lookup with token ${token} failed`,
          error
        );
        throw "";
      });

    if (
      !recognition.data.predictions[0].taxa ||
      !recognition.data.predictions[0].taxa.items
    ) {
      throw `Naturalis API v2 lookup gave no predictions.\n${JSON.stringify(
        recognition.data
      )}`;
    }

    let taxa = recognition.data.predictions[0].taxa.items;

    // get the best 5
    taxa = taxa.slice(0, 5);
    filteredTaxa = taxa.filter((taxon) => taxon.probability >= 0.02);

    if (filteredTaxa.length) {
      taxa = filteredTaxa;
    } else {
      taxa = taxa.slice(0, 2);
    }

    // Check against list of misspellings and unknown synonyms
    taxa = taxa.map((pred) => {
      pred.scientific_name =
        taxonMapper.taxa[pred.scientific_name] || pred.scientific_name;
      return pred;
    });

    // Get the data from the APIs (including accepted names of synonyms)
    for (let pred of taxa) {
      try {
        let nameResult;
        if (
          req.body.application &&
          req.body.application.toLowerCase() === "artsobservasjoner"
        ) {
          pred.name = pred.scientific_name;
        } else {
          nameResult = await getName(pred.scientific_name, false, country);

          pred.vernacularName = nameResult.vernacularName;
          pred.vernacularNames = nameResult.vernacularNames;
          pred.groupName = nameResult.groupName;
          pred.scientificNameID = nameResult.scientificNameID;
          pred.name = nameResult.scientificName;
          pred.infoUrl = nameResult.infoUrl;
          if (nameResult.redListCategory) {
            pred.redListCategory = nameResult.redListCategory;
          }
          if (nameResult.invasiveCategory) {
            pred.invasiveCategory = nameResult.invasiveCategory;
          }
        }

        pred.picture = getPicture(pred.scientific_name);
      } catch (error) {
        writeErrorLog(
          `Error while processing getName(${pred.scientific_name
          }). You can force a recache on ${encodeURI(
            "https://ai.test.artsdatabanken.no/cachetaxon/" +
            pred.scientific_name
          )}.`,
          error
        );
      }
    }

    recognition.data.predictions[0].taxa.items = taxa;

    // -------------- Code that checks for duplicates, that may come from synonyms as well as accepted names being used
    // One known case: Speyeria aglaja (as Speyeria aglaia) and Argynnis aglaja

    // if there are duplicates, add the probabilities and delete the duplicates
    // for (let pred of recognition.data.predictions) {
    //   let totalProbability = recognition.data.predictions
    //     .filter((p) => p.name === pred.name)
    //     .reduce((total, p) => total + p.probability, 0);

    //   if (totalProbability !== pred.probability) {
    //     pred.probability = totalProbability;
    //     recognition.data.predictions = recognition.data.predictions.filter(
    //       (p) => p.name !== pred.name
    //     );
    //     recognition.data.predictions.unshift(pred);
    //   }
    // }

    // // sort by the new probabilities
    // recognition.data.predictions = recognition.data.predictions.sort((a, b) => {
    //   return b.probability - a.probability;
    // });
    // -------------- end of duplicate checking code

    recognition.data.application = req.body.application;

    // Add model and location information
    recognition.data.modelInfo = {
      model: modelUsed,
      country: country || 'Unknown',
      locationSource: locationSource
    };

    return recognition.data;
  } catch (error) {
    throw error;
  }
};

// --- Secured Species Identification Endpoint
app.post("/identify", idLimiter, authenticateApiToken, upload.array("image"), async (req, res) => {
  try {
    json = await getId(req);

    // Write to the log with authentication info (includes IP, location, model)
    writelog(req, json, req.auth);

    if (req.body.application === undefined) {
      json = simplifyJson(json);
    }

    res.status(200).json(json);

    // --- Now that the reply has been sent, let each returned name have a 5% chance to be recached if its file is older than 10 days
    if (json.predictions && json.predictions[0] && json.predictions[0].taxa) {
      json.predictions[0].taxa.items.forEach((taxon) => {
        if (Math.random() < 0.05) {
          let filename = `${taxadir}/${encodeURIComponent(
            taxon.scientific_name
          )}.json`;
          if (fs.existsSync(filename)) {
            fs.stat(filename, function (err, stats) {
              if ((new Date() - stats.mtime) / (1000 * 60 * 60 * 24) > 10) {
                getName(taxon.scientific_name, true);
              }
            });
          }
        }
      });
    }
  } catch (error) {
    writeErrorLog(`Error while running getId() on /identify endpoint`, error);
    res.status(500).end();
  }
});

// --- Token Management Endpoints (Admin only)
app.get("/admin/tokens", apiLimiter, authenticateAdminToken, (req, res) => {
  try {
    const tokenList = Object.keys(validTokens).map(token => ({
      token: token.substring(0, 8) + '...',
      name: validTokens[token].name,
      application: validTokens[token].application,
      enabled: validTokens[token].enabled,
      created: validTokens[token].created
    }));
    res.status(200).json({
      count: tokenList.length,
      tokens: tokenList
    });
  } catch (error) {
    writeErrorLog('Error listing tokens', error);
    res.status(500).json({ error: 'Unable to list tokens' });
  }
});

app.post("/admin/tokens/reload", apiLimiter, authenticateAdminToken, (req, res) => {
  try {
    reloadTokens();
    res.status(200).json({
      message: 'Tokens reloaded successfully',
      count: Object.keys(validTokens).length
    });
  } catch (error) {
    writeErrorLog('Error reloading tokens', error);
    res.status(500).json({ error: 'Unable to reload tokens' });
  }
});

app.post("/admin/tokens", apiLimiter, authenticateAdminToken, (req, res) => {
  try {
    const { name, application, description } = req.body;

    // Validate required fields
    if (!name || !application) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'name and application are required fields'
      });
    }

    // Generate secure token
    const newToken = generateSecureToken();

    // Create token object
    const tokenData = {
      name: name.trim(),
      application: application.trim(),
      enabled: true,
      created: new Date().toISOString(),
      description: description ? description.trim() : `Token for ${name}`
    };

    // Add to valid tokens
    validTokens[newToken] = tokenData;

    // Save to file
    if (!saveTokens()) {
      return res.status(500).json({
        error: 'Unable to save token to file'
      });
    }

    // Return token info (including the full token for initial setup)
    res.status(201).json({
      message: 'Token created successfully',
      token: newToken,
      name: tokenData.name,
      application: tokenData.application,
      enabled: tokenData.enabled,
      created: tokenData.created,
      warning: 'Store this token securely. It will not be shown again in full.'
    });

    writeErrorLog(`Token created successfully`, `Name: ${name}, Application: ${application}, Admin IP: ${req.ip}`);
  } catch (error) {
    writeErrorLog('Error creating token', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Unable to create token'
    });
  }
});

app.patch("/admin/tokens/:tokenPrefix/enable", apiLimiter, authenticateAdminToken, (req, res) => {
  try {
    const tokenPrefix = req.params.tokenPrefix;

    // Find token by prefix
    const fullToken = Object.keys(validTokens).find(token =>
      token.startsWith(tokenPrefix) || token.substring(0, 8) === tokenPrefix
    );

    if (!fullToken || !validTokens[fullToken]) {
      return res.status(404).json({
        error: 'Token not found',
        message: 'No token found matching the provided prefix'
      });
    }

    // Enable the token
    validTokens[fullToken].enabled = true;

    // Save to file
    if (!saveTokens()) {
      return res.status(500).json({
        error: 'Unable to save token changes to file'
      });
    }

    res.status(200).json({
      message: 'Token enabled successfully',
      token: fullToken.substring(0, 8) + '...',
      name: validTokens[fullToken].name,
      application: validTokens[fullToken].application,
      enabled: true
    });

    writeErrorLog(`Token enabled`, `Token: ${fullToken.substring(0, 8)}..., Admin IP: ${req.ip}`);
  } catch (error) {
    writeErrorLog('Error enabling token', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Unable to enable token'
    });
  }
});

app.patch("/admin/tokens/:tokenPrefix/disable", apiLimiter, authenticateAdminToken, (req, res) => {
  try {
    const tokenPrefix = req.params.tokenPrefix;

    // Find token by prefix
    const fullToken = Object.keys(validTokens).find(token =>
      token.startsWith(tokenPrefix) || token.substring(0, 8) === tokenPrefix
    );

    if (!fullToken || !validTokens[fullToken]) {
      return res.status(404).json({
        error: 'Token not found',
        message: 'No token found matching the provided prefix'
      });
    }

    // Disable the token
    validTokens[fullToken].enabled = false;

    // Save to file
    if (!saveTokens()) {
      return res.status(500).json({
        error: 'Unable to save token changes to file'
      });
    }

    res.status(200).json({
      message: 'Token disabled successfully',
      token: fullToken.substring(0, 8) + '...',
      name: validTokens[fullToken].name,
      application: validTokens[fullToken].application,
      enabled: false
    });

    writeErrorLog(`Token disabled`, `Token: ${fullToken.substring(0, 8)}..., Admin IP: ${req.ip}`);
  } catch (error) {
    writeErrorLog('Error disabling token', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Unable to disable token'
    });
  }
});

app.get("/taxonimage/*", apiLimiter, authenticateAdminToken, (req, res) => {
  try {
    let taxon = decodeURI(req.originalUrl.replace("/taxonimage/", ""));
    res.status(200).send(getPicture(taxon));
  } catch (error) {
    writeErrorLog(`Error for ${req.originalUrl}`, error);
    res.status(500).end();
  }
});

app.get("/taxonimages", apiLimiter, authenticateAdminToken, (req, res) => {
  try {
    res.status(200).json(taxonPics);
  } catch (error) {
    writeErrorLog(`Error for ${req.originalUrl}`, error);
    res.status(500).end();
  }
});

app.get("/taxonimages/view", apiLimiter, (req, res) => {
  try {
    let pics = Object.entries(taxonPics);
    pics.sort();

    let html = "<html><head><style>";
    html += "img {border-radius: 50%}";
    html += "img:hover {border-radius: 0}";
    html += "</style></head><body>";
    html += `<h1>Alle ${pics.length} "profilbilder"</h1>`;
    html += "<table>";

    pics.forEach((pic) => {
      html += `<tr><td style="padding: 20px"><a href="https://artsdatabanken.no/Media/${pic[1]}" target="_blank"><img src="https://artsdatabanken.no/Media/${pic[1]}?mode=128x128"/></a></td>`;
      html += `<td><h3><i>${pic[0]}</i></h3></td></tr>`;
    });
    html += "</body></html>";

    res.status(200).send(html);
  } catch (error) {
    writeErrorLog(`Error for ${req.originalUrl}`, error);
    res.status(500).end();
  }
});

app.get("/cachetaxon/*", cacheLimiter, authenticateAdminToken, async (req, res) => {
  try {
    let taxon = decodeURI(req.originalUrl.replace("/cachetaxon/", ""));
    let name = await getName(taxon, true);
    res.status(200).json(name);
  } catch (error) {
    writeErrorLog(`Error for ${req.originalUrl}`, error);
    res.status(500).end();
  }
});

app.get("/refreshtaxonimages", cacheLimiter, authenticateAdminToken, async (req, res) => {
  try {
    // Read the file first in case the fetches fail, so it can still be uploaded manually
    if (fs.existsSync(pictureFile)) {
      taxonPics = JSON.parse(fs.readFileSync(pictureFile));
    }

    let number = await refreshtaxonimages();
    res.status(200).send(`${number} pictures found`);
  } catch (error) {
    res.status(500).end();
  }
});

app.delete("/admin/cache/taxa", apiLimiter, authenticateAdminToken, async (req, res) => {
  try {
    let deletedCount = 0;
    let errorCount = 0;

    // Read all files in the taxa cache directory
    const files = fs.readdirSync(taxadir);

    for (const file of files) {
      // Only delete .json files
      if (file.endsWith('.json')) {
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

    const message = `Cleared ${deletedCount} cached taxa files${errorCount > 0 ? ` (${errorCount} errors)` : ''}`;
    writeErrorLog(message, `Admin IP: ${req.ip}`);

    res.status(200).json({
      message: message,
      deleted: deletedCount,
      errors: errorCount,
      totalFiles: files.length
    });
  } catch (error) {
    writeErrorLog('Error clearing taxa cache', error);
    res.status(500).json({
      error: 'Failed to clear taxa cache',
      message: error.message
    });
  }
});

app.post("/", idLimiter, upload.array("image"), async (req, res) => {
  // Legacy endpoint - no authentication required for backward compatibility
  try {
    json = await getId(req);

    // Write to the log (includes IP, location, model)
    writelog(req, json);

    if (req.body.application === undefined) {
      json = simplifyJson(json);
      json.predictions = [{}].concat(json.predictions);
    }

    json.predictions[0].probability = 1;
    json.predictions[0].taxon = {
      vernacularName: "*** Utdatert versjon ***",
      name: "Vennligst oppdater Artsorakelet via app store, eller Ctrl-Shift-R på pc",
    };

    res.status(200).json(json);

    // --- Now that the reply has been sent, let each returned name have a 5% chance to be recached if its file is older than 10 days
    if (json.predictions[0].taxa) {
      json.predictions[0].taxa.items.forEach((taxon) => {
        if (Math.random() < 0.05) {
          let filename = `${taxadir}/${encodeURIComponent(
            taxon.scientific_name
          )}.json`;
          if (fs.existsSync(filename)) {
            fs.stat(filename, function (err, stats) {
              if ((new Date() - stats.mtime) / (1000 * 60 * 60 * 24) > 10) {
                getName(taxon.scientific_name, true);
              }
            });
          }
        }
      });
    }
  } catch (error) {
    writeErrorLog(`Error while running getId()`, error);
    res.status(500).end();
  }
});

app.post("/save", apiLimiter, authenticateAdminToken, upload.array("image"), async (req, res) => {
  // image saving request from the orakel service
  try {
    json = await saveImagesAndGetToken(req);
    res.status(200).json(json);
  } catch (error) {
    writeErrorLog(`Failed to save image(s)`, error);
  }
});

app.get("/", apiLimiter, (req, res) => {
  let v = "Gitless";
  const gitfile = ".git/FETCH_HEAD";
  if (fs.existsSync(gitfile)) {
    v = fs.readFileSync(gitfile).toString().split("\t")[0];
  }

  fs.stat("./server.js", function (err, stats) {
    res
      .status(200)
      .send(`<h3>Aiaiai!</h3><hr/> ${v}<br/>${dateStr("s", stats.mtime)}`);
  });
});


app.get("/image/*", apiLimiter, authenticateAdminToken, (req, res) => {
  // image request from the orakel service
  // On the form /image/id&password

  // Url used to arrive here from outside
  let url = req.originalUrl.replace("/image/", "");

  // Obtain password from the end of the url
  let password = url.split("&")[1].toString();

  // Obtain the image id's from the url
  url = url.split("&")[0];

  // Loop over all files in uploads/
  fs.readdir(`${uploadsdir}/`, (err, files) => {
    let image_list = [];

    files.forEach((file) => {
      // The id's in upload are of the format:
      // sessionid_number_timestamp this to ensure unique id's
      // to get all entries from one session, we use only the first of these
      const fileid = file.split("_")[0];

      if (fileid === url) {
        // If the request has a match in the database (it should unless the user was too slow)
        const image_to_fetch = `${uploadsdir}/${file}`;

        // read the file
        const file_buffer = fs.readFileSync(image_to_fetch);

        // decrypt the file
        let decrypted_file = decrypt(file_buffer, password);

        // add the file to the return list
        image_list.push(decrypted_file);
      }
    });
    // generate json object to return at request
    let json = { image: image_list };
    try {
      res.status(200).json(json);
    } catch (error) {
      writeErrorLog(
        `Failed to return json of saved images:\n${filelist.toString()}`,
        error
      );
      res.status(500).end();
    }
  });
});

app.get("/loglist/*", cacheLimiter, authenticateAdminToken, (req, res) => {
  // Access control is now handled by authenticateToken middleware
  try {
    var json = [];
    fs.readdir("./log", function (err, files) {
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

app.get("/getlog/*", idLimiter, authenticateAdminToken, (req, res) => {
  // Access control is now handled by authenticateToken middleware
  try {
    let filename = req.originalUrl.replace("/getlog/", "");
    const file = `./log/${decodeURI(filename)}`;
    if (fs.existsSync(file)) {
      res.download(file);
    } else {
      res.status(404).end();
    }
  } catch (error) {
    writeErrorLog(`Error in getlog endpoint`, error);
    res.status(500).end();
  }
});

// --- Path that Azure uses to check health, prevents 404 in the logs
app.get("/robots933456.txt", apiLimiter, (req, res) => {
  res.status(200).send("Hi, Azure");
});

// --- RSS feed endpoint
app.get("/rss", apiLimiter, (_req, res) => {
  res.type("application/rss+xml");
  res.sendFile(__dirname + "/cache/feed.rss");
});

// --- Admin endpoint to upload RSS file
app.post("/admin/rss", apiLimiter, authenticateAdminToken, upload.single("rss"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No RSS file provided" });
    }
    fs.writeFileSync(__dirname + "/cache/feed.rss", req.file.buffer);
    res.status(200).json({ message: "RSS feed updated successfully" });
  } catch (error) {
    console.error("Error updating RSS feed:", error);
    res.status(500).json({ error: "Failed to update RSS feed" });
  }
});

// --- Serve a favicon, prevents 404 in the logs
app.use("/favicon.ico", apiLimiter, express.static("favicon.ico"));

// Initialize IP lookup database before starting server
ipLookup.initialize().then(() => {
  ipLookupReady = true;
  console.log('IP geolocation database loaded successfully');
  app.listen(port, console.log(`Server now running on port ${port}`));
}).catch(error => {
  console.error('Failed to initialize IP lookup database:', error);
  ipLookupReady = false;
  app.listen(port, console.log(`Server running on port ${port} (IP geolocation unavailable)`));
});
