const axios = require("axios");
const fsp = require("fs/promises");
const { taxadir } = require("../config/constants");

const HEADERS = {
  "Accept-Encoding": "gzip",
  "User-Agent": "Artsorakel backend bot/4.0 (https://www.artsdatabanken.no)"
};

const cladeDescriptors = {
  Coleoptera:     { article: "en", noun: "bille" },
  Lepidoptera:    { article: "en", noun: "sommerfugl" },
  Diptera:        { article: "en", noun: "tovinge" },
  Hymenoptera:    { article: "en", noun: "årevinge" },
  Hemiptera:      { article: "en", noun: "nebbmunn" },
  Odonata:        { article: "en", noun: "øyenstikker" },
  Orthoptera:     { article: "en", noun: "rettvinge" },
  Ephemeroptera:  { article: "en", noun: "døgnflue" },
  Plecoptera:     { article: "en", noun: "steinflue" },
  Trichoptera:    { article: "en", noun: "vårflue" },
  Neuroptera:     { article: "en", noun: "nettvinge" },
  Araneae:        { article: "en", noun: "edderkopp" },
  Opiliones:      { article: "en", noun: "vevkjerring" },
  Acari:          { article: "en", noun: "midd" },
  Arachnida:      { article: "et", noun: "edderkoppdyr", containerRank: "class" },
  Crustacea:      { article: "et", noun: "krepsdyr",     containerRank: "subphylum" },
  Malacostraca:   { article: "et", noun: "krepsdyr",     containerRank: "class" },
  Aves:           { article: "en", noun: "fugl" },
  Mammalia:       { article: "et", noun: "pattedyr" },
  Actinopterygii: { article: "en", noun: "fisk" },
  Chondrichthyes: { article: "en", noun: "bruskfisk" },
  Amphibia:       { article: "et", noun: "amfibium" },
  Reptilia:       { article: "et", noun: "krypdyr" },
  Mollusca:       { article: "et", noun: "bløtdyr",      containerRank: "phylum" },
  Gastropoda:     { article: "en", noun: "snegl",        containerRank: "class" },
  Bivalvia:       { article: "en", noun: "musling",      containerRank: "class" },
  Cephalopoda:    { article: "en", noun: "blekksprut",   containerRank: "class" },
  Echinodermata:  { article: "en", noun: "pigghud",      containerRank: "phylum" },
  Annelida:       { article: "en", noun: "leddorm",      containerRank: "phylum" },
  Cnidaria:       { article: "et", noun: "nesledyr",     containerRank: "phylum" },
  Porifera:       { article: "en", noun: "svamp",        containerRank: "phylum" },
  Magnoliophyta:  { article: "en", noun: "blomsterplante" },
  Pinopsida:      { article: "et", noun: "bartre",       containerRank: "class" },
  Polypodiopsida: { article: "en", noun: "bregne",       containerRank: "class" },
  Bryophyta:      { article: "en", noun: "bladmose",     containerRank: "phylum" },
  Marchantiophyta:{ article: "en", noun: "levermose",    containerRank: "phylum" },
  Fungi:          { article: "en", noun: "sopp",         containerRank: "kingdom" },
  Basidiomycota:  { article: "en", noun: "stilksporesopp", containerRank: "phylum" },
  Ascomycota:     { article: "en", noun: "sekksporesopp",  containerRank: "phylum" }
};

const RANK_PRIORITY = ["genus", "family", "superfamily", "order", "subclass", "class", "subphylum", "phylum", "kingdom"];

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

  const subject = vernacular
    ? `${capitalize(vernacular)} (${sciNamePresentation})`
    : sciNamePresentation;

  let html = `${subject} er ${descriptor.article} ${descriptor.noun}`;
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
