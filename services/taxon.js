const axios = require("axios");
const fs = require("fs");
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

let taxonPics = {};
if (fs.existsSync(pictureFile)) {
  taxonPics = JSON.parse(fs.readFileSync(pictureFile));
}

const getListVersions = async () => {
  const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

  if (fs.existsSync(listVersionsFile)) {
    const stats = fs.statSync(listVersionsFile);
    if (stats.mtimeMs > oneWeekAgo) {
      try {
        return JSON.parse(fs.readFileSync(listVersionsFile, 'utf8'));
      } catch (error) {
        writeErrorLog('Could not parse listversions.json', error);
      }
    }
  }

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
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no) axios/0.21.1'
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
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no) axios/0.21.1'
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

  fs.writeFileSync(listVersionsFile, JSON.stringify(versions, null, 2));

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

const getName = async (sciNameId, sciName, force = false, country = null) => {
  const listVersions = await getListVersions();

  if (sciNameId) {
    const pattern = `${encodeURIComponent(sciNameId)}_`;
    const files = fs.readdirSync(taxadir).filter(f => f.startsWith(pattern) && f.endsWith('.json'));

    if (files.length > 0) {
      const existingFile = `${taxadir}/${files[0]}`;

      if (!force) {
        try {
          const cachedData = JSON.parse(fs.readFileSync(existingFile));
          if (country === 'NO') {
            if (cachedData?.redListCategories?.NO) {
              cachedData.redListCategory = cachedData.redListCategories.NO;
            }
            if (cachedData?.invasiveCategories?.NO) {
              cachedData.invasiveCategory = cachedData.invasiveCategories.NO;
            }
          }
          return cachedData;
        } catch (error) {
          writeErrorLog(`Could not parse "${existingFile}"`, error);
        }
      }

      files.forEach(f => {
        const filepath = `${taxadir}/${f}`;
        fs.unlink(filepath, function (error) {
          if (error)
            writeErrorLog(
              `Could not delete "${filepath}" while ${force ? 'forcing recache' : 'after parse error'}`,
              error
            );
        });
      });
    }
  } else {
    let filename = "_" + sciName;
    let unencoded_jsonfilename = `${taxadir}/${sanitize(filename)}.json`;
    let jsonfilename = `${taxadir}/${encodeURIComponent(filename)}.json`;

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

    if (fs.existsSync(jsonfilename)) {
      if (!force) {
        try {
          const cachedData = JSON.parse(fs.readFileSync(jsonfilename));
          if (country === 'NO') {
            if (cachedData?.redListCategories?.NO) {
              cachedData.redListCategory = cachedData.redListCategories.NO;
            }
            if (cachedData?.invasiveCategories?.NO) {
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
  }

  let nameResult = {
    vernacularName: sciName,
    vernacularNames: {},
    groupName: "",
    groupNames: {},
    scientificName: sciName,
    redListCategories: {},
    invasiveCategories: {},
  };

  let resourceObject, scientificNameIdObject, redListObject, alienSpeciesListObject;

  if (sciNameId) {
    try {
      let url = encodeURI(
        `https://artsdatabanken.no/Api/Taxon/ScientificName/${sciNameId}`
      );
      scientificNameIdObject = await axios
        .get(url, {
          timeout: 3000,
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
          throw "";
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
      return nameResult;
    }

    let taxonId = scientificNameIdObject.taxonID

    try {
      let url = encodeURI(
        `https://artsdatabanken.no/Api/Resource/Taxon/${taxonId}`
      );
      resourceObject = await axios
        .get(url, {
          timeout: 3000,
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
          throw "";
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
          timeout: 3000,
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
          throw "";
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
      return nameResult;
    }

    if (!!resourceObject) {
      let sciNameIdFromName = resourceObject.AcceptedNameUsage.ScientificNameId

      try {
        let url = encodeURI(
          `https://artsdatabanken.no/Api/Taxon/ScientificName/${sciNameIdFromName}`
        );
        scientificNameIdObject = await axios
          .get(url, {
            timeout: 3000,
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
            throw "";
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
        return nameResult;
      }
    }
  }


  if (!!resourceObject) {

    try {
      let url = encodeURI(
        `https://lister.artsdatabanken.no/odata/v1/alienspeciesassessment${listVersions.AlienSpeciesList}?filter=scientificName/ScientificNameId eq ${resourceObject.AcceptedNameUsage.ScientificNameId}&select=category`
      );
      alienSpeciesListObject = await axios
        .get(url, {
          timeout: 3000,
          headers: {
            'Accept-Encoding': 'gzip',
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no) axios/0.21.1'
          }
        })
        .catch((error) => {
          writeErrorLog(
            `Failed to ${!force ? "get info for" : "*recache*"
            } ${sciName} from ${url}.`,
            error
          );
          throw "";
        });
      alienSpeciesListObject = alienSpeciesListObject.data
    }
    catch (error) {
      writeErrorLog(
        `Error in getName(${sciNameId}) for alienSpeciesListObject. Retry: ${encodeURI(
          server_url + "/admin/taxon/reload/id/" + sciNameId
        )}.`,
        error
      );
      return nameResult;
    }


    try {
      let url = encodeURI(
        `https://lister.artsdatabanken.no/odata/v1/speciesassessment${listVersions.Redlist}?filter=ScientificNameId eq ${resourceObject.AcceptedNameUsage.ScientificNameId}&select=category`
      );
      redListObject = await axios
        .get(url, {
          timeout: 3000,
          headers: {
            'Accept-Encoding': 'gzip',
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no) axios/0.21.1'
          }
        })
        .catch((error) => {
          writeErrorLog(
            `Failed to ${!force ? "get info for" : "*recache*"
            } ${sciName} from ${url}.`,
            error
          );
          throw "";
        });
      redListObject = redListObject.data
    }
    catch (error) {
      writeErrorLog(
        `Error in getName(${sciNameId}) for redListObject. Retry: ${encodeURI(
          server_url + "/admin/taxon/reload/id/" + sciNameId
        )}.`,
        error
      );
      return nameResult;
    }



    if (resourceObject.AcceptedNameUsage?.ScientificName) {
      nameResult.scientificName = resourceObject.AcceptedNameUsage.ScientificName
    }
    if (redListObject?.value?.length) {
      nameResult.redListCategories.NO = redListObject.value[0].category;
    }

    if (alienSpeciesListObject?.value?.length) {
      nameResult.invasiveCategories.NO = alienSpeciesListObject.value[0].category;
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

  }



  const targetLanguages = ['sv', 'nl', 'en', 'es'];
  const missingLanguages = targetLanguages.filter(lang => !nameResult.vernacularNames[lang]);

  if (missingLanguages.length !== 0) {

    if (!nameResult.vernacularNames.sv) {
      try {
        const swedishUrl = encodeURI(`https://api.artdatabanken.se/taxonservice/v1/taxa/names?searchString=${nameResult.scientificName}&searchFields=Scientific&isRecommended=Yes&culture=sv_SE&page=1`);
        const swedishResponse = await axios
          .get(swedishUrl, {
            timeout: 3000,
            headers: {
              'Accept-Encoding': 'gzip',
              'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no) axios/0.21.1',
              'Ocp-Apim-Subscription-Key': process.env.ARTDATABANKEN_TOKEN
            }
          })
          .catch((error) => {
            console.log(`Failed to get Swedish name for ${nameResult.scientificName}:`, error.message);
            return null;
          });

        if (swedishResponse?.data?.data && Array.isArray(swedishResponse.data.data)) {
          const matchingTaxon = swedishResponse.data.data.find(
            item => item.name &&
              item.name.toLowerCase() === nameResult.scientificName.toLowerCase()
          );

          if (matchingTaxon?.taxonInformation?.recommendedSwedishName) {
            nameResult.vernacularNames.sv = matchingTaxon.taxonInformation.recommendedSwedishName;
          }
        }
      } catch (error) {
        console.log(`Error fetching Swedish name for ${nameResult.scientificName}:`, error.message);
      }
    }


    if (missingLanguages.length > 0) {
      try {
        const gbifUrl = encodeURI(`https://api.gbif.org/v1/species/search?datasetKey=7ddf754f-d193-4cc9-b351-99906754a03b&nameType=SCIENTIFIC&q=${nameResult.scientificName}`);
        const gbifResponse = await axios
          .get(gbifUrl, {
            timeout: 3000,
            headers: {
              'Accept-Encoding': 'gzip',
              'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no) axios/0.21.1'
            }
          })
          .catch((error) => {
            console.log(`Failed to get GBIF names for ${nameResult.scientificName}:`, error.message);
            return null;
          });

        if (gbifResponse?.data?.results && Array.isArray(gbifResponse.data.results)) {
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
                  if (nameEntry?.vernacularName) {
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


    const remainingLangs = targetLanguages.filter(lang => !nameResult.vernacularNames[lang]);
    if (remainingLangs.length > 0) {
      try {
        const wikiSpeciesUrl = encodeURI(`https://api.wikimedia.org/core/v1/wikispecies/page/${nameResult.scientificName.replace(' ', '_')}/links/language`);
        const wikiResponse = await axios
          .get(wikiSpeciesUrl, {
            timeout: 3000,
            headers: {
              'Accept-Encoding': 'gzip',
              'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no) axios/0.21.1'
            }
          })
          .catch((error) => {
            console.log(`Failed to get Wikipedia names for ${nameResult.scientificName}:`, error.message);
            return null;
          });

        if (wikiResponse?.data && Array.isArray(wikiResponse.data)) {
          for (const link of wikiResponse.data) {
            if (remainingLangs.includes(link.code) && !nameResult.vernacularNames[link.code]) {
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

    const stillMissingLangs = targetLanguages.filter(lang => !nameResult.vernacularNames[lang]);
    if (stillMissingLangs.length > 0) {
      for (const lang of stillMissingLangs) {
        try {
          const iNatUrl = encodeURI(`https://api.inaturalist.org/v1/taxa/autocomplete?q=${nameResult.scientificName.replace(' ', '+')}&per_page=1&locale=${lang}`);
          const iNatResponse = await axios
            .get(iNatUrl, {
              timeout: 3000,
              headers: {
                'Accept-Encoding': 'gzip',
                'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no) axios/0.21.1'
              }
            })
            .catch((error) => {
              console.log(`Failed to get iNaturalist ${lang} name for ${nameResult.scientificName}:`, error.message);
              return null;
            });

          if (iNatResponse?.data?.results && Array.isArray(iNatResponse.data.results)) {
            const result = iNatResponse.data.results.find(
              item => item.name &&
                item.name.toLowerCase() === nameResult.scientificName.toLowerCase() &&
                item.preferred_common_name
            );

            if (result?.preferred_common_name) {
              nameResult.vernacularNames[lang] = result.preferred_common_name;
            }
          }
        } catch (error) {
          console.log(`Error fetching iNaturalist ${lang} name for ${nameResult.scientificName}:`, error.message);
        }
      }
    }
  }

  nameResult.vernacularName =
    nameResult.vernacularNames.nb ||
    nameResult.vernacularNames.nn ||
    nameResult.scientificName ||
    sciName;


  if (!!resourceObject) {
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


  let jsonfilename;
  if (sciNameId) {
    const filename = `${sciNameId}_${nameResult.scientificName}`;
    jsonfilename = `${taxadir}/${encodeURIComponent(filename)}.json`;
  } else {
    const filename = `_${sciName}`;
    jsonfilename = `${taxadir}/${encodeURIComponent(filename)}.json`;
  }

  if (force || !fs.existsSync(jsonfilename)) {
    let data = JSON.stringify(nameResult);
    fs.writeFileSync(jsonfilename, data);
  }

  return nameResult;
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
        throw "";
      });

    if (!!page) {
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
  fs.writeFileSync(pictureFile, JSON.stringify(taxa));
  return Object.keys(taxa).length;
};

const reloadTaxonPics = () => {
  if (fs.existsSync(pictureFile)) {
    taxonPics = JSON.parse(fs.readFileSync(pictureFile));
  }
};

module.exports = {
  getListVersions,
  getName,
  getPicture,
  getTaxonPics,
  reloadTaxonImages,
  reloadTaxonPics,
  taxadir
};
