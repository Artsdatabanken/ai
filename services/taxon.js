const axios = require("axios");
const fs = require("fs");
const fsp = require("fs/promises");
const sanitize = require("sanitize-filename");
const {
  taxadir,
  pictureFile,
  listVersionsFile,
  server_url,
  groupNameTranslations,
  capitalizeFirstLetter
} = require("../config/constants");
const { writeErrorLog } = require("./logging");

const apiTimeout = 20000;
const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000;

const ENRICHMENT_BUDGET_MS = 5000;

const RECACHE_BUDGET_MS = 60000;

const newDeadline = (budgetMs = ENRICHMENT_BUDGET_MS) => Date.now() + budgetMs;

const timeLeft = (deadline) => Math.max(1, Math.min(apiTimeout, deadline - Date.now()));

const CACHE_WRITE_ERROR_INTERVAL_MS = 60 * 60 * 1000;
let lastCacheWriteErrorAt = 0;

const reportCacheWriteFailure = (filepath, error) => {
  if (Date.now() - lastCacheWriteErrorAt < CACHE_WRITE_ERROR_INTERVAL_MS) return;
  lastCacheWriteErrorAt = Date.now();
  writeErrorLog(
    `Could not write taxon cache entry "${filepath}". Nothing is being cached, ` +
    `so every request refetches and slow ones fall back to scientific names. ` +
    `Further write failures are suppressed for an hour.`,
    error
  );
};

const bareNameResult = (sciName) => ({
  vernacularName: sciName,
  vernacularNames: {},
  groupName: "",
  groupNames: {},
  scientificName: sciName,
  redListCategories: {},
  invasiveCategories: {},
});

const writeNegativeCache = (sciNameId, sciName, nameResult) => {
  const filename = sciNameId
    ? `${sciNameId}_${nameResult.scientificName}`
    : `_${sciName}`;
  const basename = `${encodeURIComponent(filename)}.json`;
  fsp
    .writeFile(
      `${taxadir}/${basename}`,
      JSON.stringify({ ...nameResult, notFound: true, cachedAt: Date.now() })
    )
    .catch((error) => reportCacheWriteFailure(`${taxadir}/${basename}`, error));
  rememberCacheFile(sciNameId, basename);
};

let taxonPics = {};
if (fs.existsSync(pictureFile)) {
  taxonPics = JSON.parse(fs.readFileSync(pictureFile));
}

const getListVersions = async () => {
  const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

  try {
    const stats = await fsp.stat(listVersionsFile);
    if (stats.mtimeMs > oneWeekAgo) {
      try {
        return JSON.parse(await fsp.readFile(listVersionsFile, 'utf8'));
      } catch (error) {
        writeErrorLog('Could not parse listversions.json', error);
      }
    }
  } catch {}

  const currentYear = new Date().getFullYear();
  const versions = {
    AlienSpeciesList: null,
    Redlist: null
  };

  for (let year = currentYear; year >= 2020; year--) {
    if (!versions.AlienSpeciesList) {
      try {
        const url = `https://lister.artsdatabanken.no/odata/v1/alienspeciesassessment${year}`;
        const response = await axios.get(url, {
          timeout: 5000,
          headers: {
            'Accept-Encoding': 'gzip',
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no)'
          }
        });
        if (response.status === 200) {
          versions.AlienSpeciesList = year;
        }
      } catch (error) {
      }
    }

    if (!versions.Redlist) {
      try {
        const url = `https://lister.artsdatabanken.no/odata/v1/speciesassessment${year}`;
        const response = await axios.get(url, {
          timeout: 5000,
          headers: {
            'Accept-Encoding': 'gzip',
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no)'
          }
        });
        if (response.status === 200) {
          versions.Redlist = year;
        }
      } catch (error) {
      }
    }

    if (versions.AlienSpeciesList && versions.Redlist) {
      break;
    }
  }

  if (!versions.AlienSpeciesList) versions.AlienSpeciesList = 2023;
  if (!versions.Redlist) versions.Redlist = 2021;

  fsp.writeFile(listVersionsFile, JSON.stringify(versions, null, 2)).catch(() => {});

  return versions;
};

const getPicture = (sciName) => {
  if (!sciName) return null;
  sciName = sciName.replaceAll("×", "x").replaceAll("ë", "e");

  let pic = taxonPics[sciName];
  if (pic) {
    return `https://artsdatabanken.no/Media/${pic}?mode=128x128`;
  }

  return null;
};

const getTaxonPics = () => taxonPics;

const TARGET_LANGUAGES = ['sv', 'nl', 'en', 'es'];

const stripInternal = ({ _pending, _assessmentId, ...clean }) => clean;

let taxaIndex = null;

const indexKey = (sciNameId) => encodeURIComponent(sciNameId);

const getTaxaIndex = async () => {
  if (taxaIndex) return taxaIndex;

  const index = new Map();
  try {
    for (const file of await fsp.readdir(taxadir)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      const separator = file.indexOf('_');
      if (separator > 0) {
        index.set(file.slice(0, separator), file);
      }
    }
  } catch {}

  taxaIndex = index;
  return taxaIndex;
};

const rememberCacheFile = (sciNameId, filename) => {
  if (taxaIndex && sciNameId) taxaIndex.set(indexKey(sciNameId), filename);
};

const forgetCacheFile = (sciNameId) => {
  if (taxaIndex && sciNameId) taxaIndex.delete(indexKey(sciNameId));
};

const applyCountryCategories = (nameResult, country) => {
  if (country === 'NO') {
    if (nameResult?.redListCategories?.NO) {
      nameResult.redListCategory = nameResult.redListCategories.NO;
    }
    if (nameResult?.invasiveCategories?.NO) {
      nameResult.invasiveCategory = nameResult.invasiveCategories.NO;
    }
  }
  return nameResult;
};

const getName = async (
  sciNameId,
  sciName,
  force = false,
  country = null,
  deadline = newDeadline(force ? RECACHE_BUDGET_MS : ENRICHMENT_BUDGET_MS)
) => {
  const listVersions = await getListVersions();

  let nameResult = null;
  let assessmentId = null;
  let itemsToResolve = null;

  if (sciNameId) {
    const index = await getTaxaIndex();
    const indexedFile = index.get(indexKey(sciNameId));
    const files = indexedFile ? [indexedFile] : [];

    if (files.length > 0) {
      const existingFile = `${taxadir}/${files[0]}`;

      if (!force) {
        try {
          const cachedData = JSON.parse(await fsp.readFile(existingFile, 'utf8'));
          if (cachedData.notFound === true) {
            if (Date.now() - cachedData.cachedAt < NEGATIVE_CACHE_TTL_MS) {
              return bareNameResult(sciName);
            }
          } else if (cachedData._pending && cachedData._pending.length) {
            nameResult = cachedData;
            assessmentId = cachedData._assessmentId || null;
            itemsToResolve = cachedData._pending;
          } else {
            return applyCountryCategories(stripInternal(cachedData), country);
          }
        } catch (error) {
          writeErrorLog(`Could not parse "${existingFile}"`, error);
        }
      }

      if (!itemsToResolve) {
        forgetCacheFile(sciNameId);
        for (const f of files) {
          const filepath = `${taxadir}/${f}`;
          fsp.unlink(filepath).catch((error) => {
            writeErrorLog(
              `Could not delete "${filepath}" while ${force ? 'forcing recache' : 'after parse error'}`,
              error
            );
          });
        }
      }
    }
  } else {
    let filename = "_" + sciName;
    let unencoded_jsonfilename = `${taxadir}/${sanitize(filename)}.json`;
    let jsonfilename = `${taxadir}/${encodeURIComponent(filename)}.json`;

    if (unencoded_jsonfilename !== jsonfilename) {
      fsp.unlink(unencoded_jsonfilename).catch(() => {});
    }

    let fileExists = false;
    try {
      await fsp.access(jsonfilename);
      fileExists = true;
    } catch {}

    if (fileExists) {
      if (!force) {
        try {
          const cachedData = JSON.parse(await fsp.readFile(jsonfilename, 'utf8'));
          if (cachedData.notFound === true) {
            if (Date.now() - cachedData.cachedAt < NEGATIVE_CACHE_TTL_MS) {
              return bareNameResult(sciName);
            }
            fsp.unlink(jsonfilename).catch(() => {});
          } else if (cachedData._pending && cachedData._pending.length) {
            nameResult = cachedData;
            assessmentId = cachedData._assessmentId || null;
            itemsToResolve = cachedData._pending;
          } else {
            return applyCountryCategories(stripInternal(cachedData), country);
          }
        } catch (error) {
          writeErrorLog(`Could not parse "${jsonfilename}"`, error);
          fsp.unlink(jsonfilename).catch(() => {});
        }
      } else {
        fsp.unlink(jsonfilename).catch(() => {});
      }
    }
  }

  if (!itemsToResolve) {
    nameResult = bareNameResult(sciName);
    let scientificNameIdObject, resourceObject;

    if (sciNameId) {
      try {
        let url = encodeURI(
          `https://artsdatabanken.no/Api/Taxon/ScientificName/${sciNameId}`
        );
        scientificNameIdObject = await axios
          .get(url, {
            timeout: timeLeft(deadline),
            headers: {
              'Accept-Encoding': 'gzip',
              'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0'
            }
          })
          .catch((error) => {
            writeErrorLog(
              `Failed to ${!force ? "get info for" : "*recache*"
              } ${sciName} from ${url}.`,
              error
            );
            throw error;
          });
        scientificNameIdObject = scientificNameIdObject.data
      }
      catch (error) {
        writeErrorLog(
          `Error in getName(${sciNameId}) for scientificNameIdObject from id. Retry: ${encodeURI(
            server_url + "/admin/taxon/reload/id/" + sciNameId
          )}.`,
          error
        );
        writeNegativeCache(sciNameId, sciName, nameResult);
        return nameResult;
      }

      let taxonId = scientificNameIdObject.taxonID

      try {
        let url = encodeURI(
          `https://artsdatabanken.no/Api/Resource/Taxon/${taxonId}`
        );
        resourceObject = await axios
          .get(url, {
            timeout: timeLeft(deadline),
            headers: {
              'Accept-Encoding': 'gzip',
              'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0'
            }
          })
          .catch((error) => {
            writeErrorLog(
              `Failed to ${!force ? "get info for" : "*recache*"
              } ${taxonId} from ${url}.`,
              error
            );
            throw error;
          });
        resourceObject = resourceObject.data
      }
      catch (error) {
        writeErrorLog(
          `Error in getName(${sciNameId}) for resourceObject from id. Retry: ${encodeURI(
            server_url + "/admin/taxon/reload/id/" + sciNameId
          )}.`,
          error
        );
        writeNegativeCache(sciNameId, sciName, nameResult);
        return nameResult;
      }
    }
    else {
      try {
        let url = encodeURI(
          `https://artsdatabanken.no/api/Resource/?Take=250&Type=taxon&Name=${sciName}`
        );
        let taxon = await axios
          .get(url, {
            timeout: timeLeft(deadline),
            headers: {
              'Accept-Encoding': 'gzip',
              'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0'
            }
          })
          .catch((error) => {
            writeErrorLog(
              `Failed to ${!force ? "get info for" : "*recache*"
              } ${sciName} from ${url}.`,
              error
            );
            throw error;
          });

        resourceObject = taxon.data.find(
          (t) => t.Name.includes(sciName) && t.AcceptedNameUsage
        );
      }
      catch (error) {
        writeErrorLog(
          `Error in getName(${sciName}) for resourceObject from name. Retry: ${encodeURI(
            server_url + "/admin/taxon/reload/name/" + sciName
          )}.`,
          error
        );
        writeNegativeCache(sciNameId, sciName, nameResult);
        return nameResult;
      }

      if (resourceObject) {
        let sciNameIdFromName = resourceObject.AcceptedNameUsage.ScientificNameId

        try {
          let url = encodeURI(
            `https://artsdatabanken.no/Api/Taxon/ScientificName/${sciNameIdFromName}`
          );
          scientificNameIdObject = await axios
            .get(url, {
              timeout: timeLeft(deadline),
              headers: {
                'Accept-Encoding': 'gzip',
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0'
              }
            })
            .catch((error) => {
              writeErrorLog(
                `Failed to ${!force ? "get info for" : "*recache*"
                } ${sciName} from ${url}.`,
                error
              );
              throw error;
            });
          scientificNameIdObject = scientificNameIdObject.data
        }
        catch (error) {
          writeErrorLog(
            `Error in getName(${sciNameId}) for scientificNameIdObject from name. Retry: ${encodeURI(
              server_url + "/admin/taxon/reload/id/" + sciNameId
            )}.`,
            error
          );
          writeNegativeCache(sciNameId, sciName, nameResult);
          return nameResult;
        }
      }
    }

    if (!!resourceObject) {
      assessmentId = resourceObject.AcceptedNameUsage?.ScientificNameId || null;

      if (resourceObject.AcceptedNameUsage?.ScientificName) {
        nameResult.scientificName = resourceObject.AcceptedNameUsage.ScientificName
      }

      if (scientificNameIdObject?.dynamicProperties) {
        let artsobsname = scientificNameIdObject.dynamicProperties.find(
          (dp) =>
            dp.Name === "GruppeNavn" &&
            dp.Properties.find((p) => p.Value === "Artsobservasjoner")
        );

        if (artsobsname?.Value?.trim()) {
          const rawGroupName = artsobsname.Value.toLowerCase();
          const capitalizedGroupName = capitalizeFirstLetter(artsobsname.Value);

          if (groupNameTranslations[rawGroupName]) {
            nameResult.groupNames = groupNameTranslations[rawGroupName];
            nameResult.groupName = capitalizedGroupName;
          } else {
            nameResult.groupName = capitalizedGroupName;
            nameResult.groupNames = { 'nb': capitalizedGroupName, 'nn': capitalizedGroupName, 'se': capitalizedGroupName };
          }
        }
      }

      for (const [key, value] of Object.entries(resourceObject)) {
        if (key.startsWith("RecommendedVernacularName_") && value) {
          let langCode = key.replace("RecommendedVernacularName_", "");
          langCode = langCode.split("-")[0]
          nameResult.vernacularNames[langCode] = value;
        }
      }

      if (resourceObject.Description) {
        const description =
          resourceObject.Description.find(
            (desc) =>
              desc.Language == "nb" ||
              desc.Language == "no" ||
              desc.Language == "nn"
          ) || resourceObject.Description[0];

        nameResult.infoUrl = description.Id.replace(
          "Nodes/",
          "https://artsdatabanken.no/Pages/"
        );
      } else {
        nameResult.infoUrl =
          "https://artsdatabanken.no/" + resourceObject.Id;
      }
    }

    itemsToResolve = [...TARGET_LANGUAGES];
    if (resourceObject) {
      itemsToResolve.push('redlist', 'alien');
    }
  }

  const erroredItems = new Set();

  const candidates = {};
  const addCandidate = (lang, source, value) => {
    if (!value) return;
    candidates[lang] = candidates[lang] || {};
    candidates[lang][source] = value;
  };

  const langsWanted = itemsToResolve.filter(item => TARGET_LANGUAGES.includes(item));
  const langsMissing = langsWanted.filter(lang => !nameResult.vernacularNames[lang]);
  const lookups = [];

  if (langsMissing.includes('sv')) {
    lookups.push((async () => {
      try {
        const swedishUrl = encodeURI(`https://api.artdatabanken.se/taxonservice/v1/taxa/names?searchString=${nameResult.scientificName}&searchFields=Scientific&isRecommended=Yes&culture=sv_SE&page=1`);
        const swedishResponse = await axios.get(swedishUrl, {
          timeout: timeLeft(deadline),
          headers: {
            'Accept-Encoding': 'gzip',
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no)',
            'Ocp-Apim-Subscription-Key': process.env.ARTDATABANKEN_TOKEN
          }
        });

        if (Array.isArray(swedishResponse?.data?.data)) {
          const matchingTaxon = swedishResponse.data.data.find(
            item => item.name &&
              item.name.toLowerCase() === nameResult.scientificName.toLowerCase()
          );
          addCandidate('sv', 'swedish', matchingTaxon?.taxonInformation?.recommendedSwedishName);
        }
      } catch (error) {
        console.log(`Failed to get Swedish name for ${nameResult.scientificName}:`, error.message);
        erroredItems.add('sv');
      }
    })());
  }

  for (const lang of langsMissing) {
    lookups.push((async () => {
      try {
        const iNatUrl = encodeURI(`https://api.inaturalist.org/v1/taxa/autocomplete?q=${nameResult.scientificName.replace(' ', '+')}&per_page=1&locale=${lang}`);
        const iNatResponse = await axios.get(iNatUrl, {
          timeout: timeLeft(deadline),
          headers: {
            'Accept-Encoding': 'gzip',
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no)'
          }
        });

        if (Array.isArray(iNatResponse?.data?.results)) {
          const result = iNatResponse.data.results.find(
            item => item.name &&
              item.name.toLowerCase() === nameResult.scientificName.toLowerCase() &&
              item.preferred_common_name
          );
          addCandidate(lang, 'inat', result?.preferred_common_name);
        }
      } catch (error) {
        console.log(`Failed to get iNaturalist ${lang} name for ${nameResult.scientificName}:`, error.message);
        erroredItems.add(lang);
      }
    })());
  }

  if (langsMissing.length) {
    lookups.push((async () => {
      try {
        const wikiSpeciesUrl = encodeURI(`https://species.wikimedia.org/w/api.php?action=query&titles=${nameResult.scientificName}&prop=langlinks&lllimit=500&format=json`);
        const wikiResponse = await axios.get(wikiSpeciesUrl, {
          timeout: timeLeft(deadline),
          headers: {
            'Accept-Encoding': 'gzip',
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no)'
          }
        });

        const pages = wikiResponse?.data?.query?.pages;
        if (pages) {
          for (const page of Object.values(pages)) {
            for (const link of page.langlinks || []) {
              if (langsMissing.includes(link.lang)) {
                const cleanTitle = link['*'].replace(/\s*\([^)]*\)/g, '').trim();
                if (cleanTitle && cleanTitle !== nameResult.scientificName) {
                  addCandidate(link.lang, 'wiki', cleanTitle);
                }
              }
            }
          }
        }
      } catch (error) {
        console.log(`Failed to get Wikipedia names for ${nameResult.scientificName}:`, error.message);
        langsMissing.forEach(lang => erroredItems.add(lang));
      }
    })());
  }

  if (itemsToResolve.includes('redlist') && assessmentId) {
    lookups.push((async () => {
      const url = encodeURI(
        `https://lister.artsdatabanken.no/odata/v1/speciesassessment${listVersions.Redlist}?filter=ScientificNameId eq ${assessmentId}&select=category`
      );
      try {
        const redListObject = await axios.get(url, {
          timeout: timeLeft(deadline),
          headers: {
            'Accept-Encoding': 'gzip',
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no)'
          }
        });

        if (redListObject.data?.value?.length) {
          nameResult.redListCategories.NO = redListObject.data.value[0].category;
        }
      } catch (error) {
        writeErrorLog(
          `Error in getName(${sciNameId}) for redListObject from ${url}. Retry: ${encodeURI(
            server_url + "/admin/taxon/reload/id/" + sciNameId
          )}.`,
          error
        );
        erroredItems.add('redlist');
      }
    })());
  }

  if (itemsToResolve.includes('alien') && assessmentId) {
    lookups.push((async () => {
      const url = encodeURI(
        `https://lister.artsdatabanken.no/odata/v1/alienspeciesassessment${listVersions.AlienSpeciesList}?filter=scientificName/ScientificNameId eq ${assessmentId}&select=category`
      );
      try {
        const alienSpeciesListObject = await axios.get(url, {
          timeout: timeLeft(deadline),
          headers: {
            'Accept-Encoding': 'gzip',
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no)'
          }
        });

        if (alienSpeciesListObject.data?.value?.length) {
          nameResult.invasiveCategories.NO = alienSpeciesListObject.data.value[0].category;
        }
      } catch (error) {
        writeErrorLog(
          `Error in getName(${sciNameId}) for alienSpeciesListObject from ${url}. Retry: ${encodeURI(
            server_url + "/admin/taxon/reload/id/" + sciNameId
          )}.`,
          error
        );
        erroredItems.add('alien');
      }
    })());
  }

  await Promise.allSettled(lookups);

  for (const lang of langsMissing) {
    if (nameResult.vernacularNames[lang]) continue;
    const found = candidates[lang];
    if (found) {
      nameResult.vernacularNames[lang] = found.swedish || found.inat || found.wiki;
    }
  }

  const pending = itemsToResolve.filter(item => {
    if (!erroredItems.has(item)) return false;
    if (TARGET_LANGUAGES.includes(item)) return !nameResult.vernacularNames[item];
    return true;
  });

  nameResult.vernacularName =
    nameResult.vernacularNames.nb ||
    nameResult.vernacularNames.nn ||
    nameResult.scientificName ||
    sciName;

  const cleanResult = stripInternal(nameResult);
  const toWrite = pending.length
    ? { ...cleanResult, _pending: pending, _assessmentId: assessmentId }
    : cleanResult;

  let jsonfilename;
  if (sciNameId) {
    const basename = `${encodeURIComponent(`${sciNameId}_${cleanResult.scientificName}`)}.json`;
    jsonfilename = `${taxadir}/${basename}`;

    const index = await getTaxaIndex();
    const previous = index.get(indexKey(sciNameId));
    if (previous && previous !== basename) {
      const filepath = `${taxadir}/${previous}`;
      fsp.unlink(filepath).catch((error) => {
        writeErrorLog(`Could not delete "${filepath}" while writing new cache entry`, error);
      });
    }
    rememberCacheFile(sciNameId, basename);
  } else {
    const filename = `_${sciName}`;
    jsonfilename = `${taxadir}/${encodeURIComponent(filename)}.json`;
  }

  fsp.writeFile(jsonfilename, JSON.stringify(toWrite)).catch((error) => reportCacheWriteFailure(jsonfilename, error));

  return applyCountryCategories(cleanResult, country);
};

const RECACHE_SAMPLE_RATE = 0.25;
const RECACHE_AFTER_DAYS = 10;
const FORCE_RECACHE_AFTER_DAYS = 15;
const CACHE_MAX_AGE_DAYS = 60;

const pruneTaxonCache = async (maxAgeDays = CACHE_MAX_AGE_DAYS) => {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let files = [];
  try {
    files = await fsp.readdir(taxadir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filepath = `${taxadir}/${file}`;
    try {
      const stats = await fsp.stat(filepath);
      if (stats.mtimeMs >= cutoff) continue;
      await fsp.unlink(filepath);
      removed++;
      if (taxaIndex && !file.startsWith('_')) {
        const separator = file.indexOf('_');
        if (separator > 0) taxaIndex.delete(file.slice(0, separator));
      }
    } catch (error) {
      writeErrorLog(`Could not prune "${filepath}"`, error);
    }
  }

  if (removed) {
    console.log(`Pruned ${removed} taxon cache entries older than ${maxAgeDays} days`);
  }
  return removed;
};

const maybeRecache = async (sciNameId, sciName) => {
  let basename;
  if (sciNameId) {
    basename = (await getTaxaIndex()).get(indexKey(sciNameId));
  } else if (sciName) {
    basename = `${encodeURIComponent(`_${sciName}`)}.json`;
  }
  if (!basename) return false;

  let ageDays;
  try {
    const stats = await fsp.stat(`${taxadir}/${basename}`);
    ageDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
  } catch {
    return false;
  }

  if (ageDays <= RECACHE_AFTER_DAYS) return false;
  if (ageDays <= FORCE_RECACHE_AFTER_DAYS && Math.random() >= RECACHE_SAMPLE_RATE) return false;

  await getName(sciNameId, sciName, true);
  return true;
};

const reloadTaxonImages = async () => {
  const pages = [342548, 342550, 342551, 342552, 342553, 342554];
  let taxa = {};

  for (let index = 0; index < pages.length; index++) {
    let pageId = pages[index];
    let url = encodeURI(`https://www.artsdatabanken.no/api/Content/${pageId}`);
    let page = await axios
      .get(url, {
        timeout: 10000,
        headers: {
          'Accept-Encoding': 'gzip',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0'
        }
      })
      .catch((error) => {
        writeErrorLog(
          `Error getting "${url}" while running reloadTaxonImages`,
          error
        );
        throw error;
      });

    if (page) {
      page.data.Files.forEach((f) => {
        if (f.FileUrl) {
          let name = f.Title.split(".")[0].replaceAll("_", " ");
          let value = f.Id.split("/")[1];
          taxa[name] = value;
        }
      });
    }
  }

  taxonPics = taxa;
  await fsp.writeFile(pictureFile, JSON.stringify(taxa));
  return Object.keys(taxa).length;
};

module.exports = {
  getName,
  getPicture,
  getTaxonPics,
  maybeRecache,
  pruneTaxonCache,
  reloadTaxonImages,
  newDeadline,
  ENRICHMENT_BUDGET_MS,
  taxadir
};
