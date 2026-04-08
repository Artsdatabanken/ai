const axios = require("axios");
const fsp = require("fs/promises");
const { taxadir } = require("../config/constants");
const { cladeDescriptors } = require("../config/descriptionStubDescriptors");

const HEADERS = {
  "Accept-Encoding": "gzip",
  "User-Agent": "Artsorakel backend bot/4.0 (https://www.artsdatabanken.no)"
};

const RANK_PRIORITY = ["genus", "family", "superfamily", "infraorder", "suborder", "order", "subclass", "class", "subphylum", "phylum", "kingdom"];

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const findDescriptor = (higherClassification) => {
  const sorted = [...higherClassification].sort((a, b) => {
    const ai = RANK_PRIORITY.indexOf(a.taxonRank);
    const bi = RANK_PRIORITY.indexOf(b.taxonRank);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  for (const t of sorted) {
    if (cladeDescriptors[t.scientificName]) return cladeDescriptors[t.scientificName];
  }
  return null;
};

const fetchTaxonResource = async (taxonID) => {
  try {
    const url = `https://artsdatabanken.no/Api/Resource/Taxon/${taxonID}`;
    const resp = await axios.get(url, { timeout: 5000, headers: HEADERS });
    return resp.data;
  } catch {
    return null;
  }
};

const fetchScientificName = async (sciNameId) => {
  const url = `https://artsdatabanken.no/Api/Taxon/ScientificName/${encodeURIComponent(sciNameId)}`;
  const resp = await axios.get(url, { timeout: 5000, headers: HEADERS });
  return resp.data;
};

const getDescriptionStub = async (sciNameId) => {
  const data = await fetchScientificName(sciNameId);
  if (!data) return null;

  const sciName = data.scientificName;
  const sciNamePresentation = data.scientificNamePresentation || `<i>${sciName}</i>`;
  const higher = Array.isArray(data.higherClassification) ? data.higherClassification : [];

  const speciesResource = await fetchTaxonResource(data.taxonID);
  const vernacular =
    speciesResource?.["RecommendedVernacularName_nb-NO"] ||
    speciesResource?.["RecommendedVernacularName_nn-NO"] ||
    null;

  const descriptor = findDescriptor(higher) || { article: "en", noun: "art", containerRank: "family" };
  const containerRank = descriptor.containerRank || "family";

  const rankLabels = {
    family: "familien",
    superfamily: "overfamilien",
    order: "ordenen",
    class: "klassen",
    subphylum: "underrekken",
    phylum: "rekken",
    kingdom: "riket"
  };

  const containerTaxon = higher.find((t) => t.taxonRank === containerRank);
  let containerName = null;
  if (containerTaxon) {
    const res = await fetchTaxonResource(containerTaxon.taxonID);
    const nbName =
      res?.["RecommendedVernacularName_nb-NO"] ||
      res?.["RecommendedVernacularName_nn-NO"] ||
      null;
    const label = rankLabels[containerRank];
    if (nbName) {
      containerName = label && nbName.toLowerCase().endsWith(label)
        ? nbName
        : label
          ? `${label} ${nbName}`
          : nbName;
    } else {
      containerName = label
        ? `${label} ${containerTaxon.scientificName}`
        : containerTaxon.scientificName;
    }
  }

  let article = descriptor.article;
  let noun = descriptor.noun;
  if (descriptor.nounFromContainerSuffix && containerName) {
    const lower = containerName.toLowerCase();
    for (const [suffix, override] of Object.entries(descriptor.nounFromContainerSuffix)) {
      if (lower.endsWith(suffix)) {
        article = override.article || article;
        noun = override.noun || noun;
        break;
      }
    }
  }

  const subject = vernacular
    ? `${capitalize(vernacular)} (${sciNamePresentation})`
    : sciNamePresentation;

  let html = `${subject} er ${article} ${noun}`;
  if (containerName) html += ` i ${containerName}`;
  html += ".";

  return html;
};

const seedSpeciesIds = [
  "100110", "135429", "3838", "48018", "26115", "32861", "39823", "8439", "5824", "100023"
];

const getRandomAcceptedSpeciesId = async () => {
  let pool = [...seedSpeciesIds];
  try {
    const files = await fsp.readdir(taxadir);
    for (const f of files) {
      const m = f.match(/^(\d+)_.*%20.+\.json$/);
      if (m) pool.push(m[1]);
    }
  } catch {}
  pool = [...new Set(pool)];
  return pool[Math.floor(Math.random() * pool.length)];
};

module.exports = { getDescriptionStub, getRandomAcceptedSpeciesId, cladeDescriptors };
