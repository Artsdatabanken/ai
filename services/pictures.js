const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { cachedir, server_url } = require("../config/constants");
const { writeErrorLog } = require("./logging");

const picturesdir = `${cachedir}/pictures`;
const indexFile = `${picturesdir}/index.json`;

const PICTURE_SIZES = [64, 128, 256, 512, 1024];
const REQUIRED_SIZES = [64, 128, 256];
const INAT_LICENSES = ["cc0", "cc-by", "cc-by-sa"];
const SOURCE_TYPES = ["inaturalist", "upload", "artsdatabanken"];
const WEBSITE_PICTURE_PAGES = [342548, 342550, 342551, 342552, 342553, 342554];

const BOT_HEADERS = {
  "Accept-Encoding": "gzip",
  "User-Agent": "Artsorakel backend bot/4.0 (https://www.artsdatabanken.no)"
};
const WEBSITE_HEADERS = {
  "Accept-Encoding": "gzip",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0"
};

const publicBaseUrl = () => (process.env.PUBLIC_URL || server_url).replace(/\/+$/, "");

const normalizeName = (name) => {
  const cleaned = String(name || "")
    .replaceAll("×", "x")
    .replaceAll("ë", "e")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
};

let pictureIndex = {};
try {
  fs.mkdirSync(picturesdir, { recursive: true });
  if (fs.existsSync(indexFile)) {
    pictureIndex = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  }
} catch (error) {
  writeErrorLog(`Could not read "${indexFile}", starting without taxon pictures`, error);
  pictureIndex = {};
}

let indexWrites = Promise.resolve();

const saveIndex = () => {
  const write = indexWrites.then(async () => {
    const tmpFile = `${indexFile}.tmp`;
    await fsp.writeFile(tmpFile, JSON.stringify(pictureIndex, null, 2));
    await fsp.rename(tmpFile, indexFile);
  });
  indexWrites = write.catch(() => {});
  return write;
};

const pictureUrl = (id, size) => `${publicBaseUrl()}/taxon/picture/${id}/${size}.jpg`;

const getPicture = (name) => pictureIndex[normalizeName(name)] || null;

const getPictureUrl = (name, size = 128) => {
  const entry = getPicture(name);
  return entry ? pictureUrl(entry.id, size) : null;
};

const getPictureNames = () => Object.keys(pictureIndex).sort();

const describePicture = (entry) =>
  entry && {
    ...entry,
    urls: Object.fromEntries(entry.sizes.map((size) => [size, `/taxon/picture/${entry.id}/${size}.jpg`]))
  };

const jpegDimensions = (buffer) => {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
};

const slugify = (name) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60) || "taxon";

const isPictureId = (id) => /^[a-z0-9-]{1,80}$/.test(id);

const picturesRoot = path.resolve(picturesdir);

const pictureFilePath = (id, size) => {
  if (!isPictureId(id) || !PICTURE_SIZES.includes(size)) return null;
  const filePath = path.resolve(picturesRoot, id, `${size}.jpg`);
  return filePath.startsWith(picturesRoot + path.sep) ? filePath : null;
};

const text = (value, max) => (value ? String(value).substring(0, max) : null);

const savePicture = async (rawName, files, meta) => {
  const name = normalizeName(rawName);
  if (!name) throw Object.assign(new Error("A species name is required"), { status: 400 });

  const bySize = {};
  for (const file of files) {
    const match = /^size-(\d+)$/.exec(file.fieldname);
    const size = match && Number(match[1]);
    if (!PICTURE_SIZES.includes(size)) {
      throw Object.assign(new Error(`Unexpected file field "${file.fieldname}"`), { status: 400 });
    }
    const dimensions = jpegDimensions(file.buffer);
    if (!dimensions || dimensions.width !== size || dimensions.height !== size) {
      throw Object.assign(
        new Error(`The ${size} px file is not a ${size}×${size} JPEG`),
        { status: 400 }
      );
    }
    bySize[size] = file.buffer;
  }

  const missing = REQUIRED_SIZES.filter((size) => !bySize[size]);
  if (missing.length) {
    throw Object.assign(new Error(`Missing sizes: ${missing.join(", ")}`), { status: 400 });
  }

  const source = meta?.source || {};
  if (source.type === "artsdatabanken" && meta?.onlyIfMissing && pictureIndex[name]) {
    return { name, skipped: true, picture: describePicture(pictureIndex[name]) };
  }

  const id = `${slugify(name)}-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const dir = path.resolve(picturesdir, id);
  await fsp.mkdir(dir, { recursive: true });

  const sizes = Object.keys(bySize).map(Number).sort((a, b) => a - b);
  for (const size of sizes) {
    await fsp.writeFile(path.join(dir, `${size}.jpg`), bySize[size]);
  }

  const entry = {
    id,
    sizes,
    savedAt: new Date().toISOString(),
    source: {
      type: SOURCE_TYPES.includes(source.type) ? source.type : "upload",
      license: text(source.license, 40),
      attribution: text(source.attribution, 300),
      photographer: text(source.photographer, 200),
      url: text(source.url, 500),
      photoId: Number(source.photoId) || null,
      observationId: Number(source.observationId) || null,
      mediaId: text(source.mediaId, 40),
      filename: text(source.filename, 200)
    },
    crop: meta?.crop
      ? {
          x: Math.round(Number(meta.crop.x) || 0),
          y: Math.round(Number(meta.crop.y) || 0),
          side: Math.round(Number(meta.crop.side) || 0),
          sourceWidth: Math.round(Number(meta.crop.sourceWidth) || 0),
          sourceHeight: Math.round(Number(meta.crop.sourceHeight) || 0)
        }
      : null
  };

  pictureIndex[name] = entry;
  await saveIndex();
  return { name, picture: describePicture(entry) };
};

const removePicture = async (rawName) => {
  const name = normalizeName(rawName);
  if (!pictureIndex[name]) return false;
  delete pictureIndex[name];
  await saveIndex();
  return true;
};

const fetchWebsitePictureList = async () => {
  const pictures = {};

  for (const pageId of WEBSITE_PICTURE_PAGES) {
    const response = await axios.get(`https://www.artsdatabanken.no/api/Content/${pageId}`, {
      timeout: 20000,
      headers: WEBSITE_HEADERS
    });

    for (const file of response.data?.Files || []) {
      if (!file.FileUrl || !file.Title || !file.Id) continue;
      const name = normalizeName(file.Title.split(".")[0].replaceAll("_", " "));
      const mediaId = file.Id.split("/")[1];
      pictures[name] = {
        name,
        mediaId,
        license: file.License?.Heading || null,
        url: `https://artsdatabanken.no/Media/${mediaId}`
      };
    }
  }

  return Object.values(pictures)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => ({ ...item, hasPicture: !!pictureIndex[item.name] }));
};

const inatTaxonCache = new Map();

const describeInatTaxon = (taxon, match) => ({
  id: taxon.id,
  name: taxon.name,
  rank: taxon.rank,
  commonName: taxon.preferred_common_name || null,
  match,
  url: `https://www.inaturalist.org/taxa/${taxon.id}`
});

const findInatTaxon = async (name, taxonId) => {
  const key = taxonId ? `id:${taxonId}` : name;
  if (inatTaxonCache.has(key)) return inatTaxonCache.get(key);

  let result;
  if (taxonId) {
    const response = await axios.get(`https://api.inaturalist.org/v1/taxa/${Number(taxonId)}`, {
      params: { locale: "nb" },
      timeout: 15000,
      headers: BOT_HEADERS
    });
    const taxon = response.data?.results?.[0];
    result = { taxon: taxon ? describeInatTaxon(taxon, "chosen") : null, suggestions: [] };
  } else {
    const response = await axios.get("https://api.inaturalist.org/v1/taxa/autocomplete", {
      params: { q: name, is_active: "any", per_page: 20, locale: "nb" },
      timeout: 15000,
      headers: BOT_HEADERS
    });
    const results = response.data?.results || [];
    const wanted = name.toLowerCase();
    const active = results.filter((taxon) => taxon.is_active);
    const exact = active.find((taxon) => taxon.name.toLowerCase() === wanted);
    const viaSynonym = active.filter(
      (taxon) => String(taxon.matched_term || "").toLowerCase() === wanted && taxon.name.toLowerCase() !== wanted
    );

    if (exact) {
      result = { taxon: describeInatTaxon(exact, "exact"), suggestions: [] };
    } else if (viaSynonym.length === 1) {
      result = { taxon: describeInatTaxon(viaSynonym[0], "synonym"), suggestions: [] };
    } else {
      result = {
        taxon: null,
        suggestions: active.slice(0, 8).map((taxon) => describeInatTaxon(taxon, "suggestion"))
      };
    }
  }

  inatTaxonCache.set(key, result);
  return result;
};

const photoVariant = (url, variant) => url.replace(/\/square\.(jpe?g|png|gif)/i, `/${variant}.$1`);

const findInatPhotos = async (rawName, license, page = 1, taxonId = null) => {
  const name = normalizeName(rawName);
  if (!INAT_LICENSES.includes(license)) {
    throw Object.assign(new Error(`License must be one of ${INAT_LICENSES.join(", ")}`), { status: 400 });
  }

  const { taxon, suggestions } = await findInatTaxon(name, taxonId);
  if (!taxon) return { taxon: null, suggestions, license, page, totalObservations: 0, photos: [] };

  const perPage = 24;
  const response = await axios.get("https://api.inaturalist.org/v1/observations", {
    params: {
      taxon_id: taxon.id,
      quality_grade: "research",
      photo_license: license,
      order_by: "votes",
      order: "desc",
      per_page: perPage,
      page
    },
    timeout: 20000,
    headers: BOT_HEADERS
  });

  const observations = response.data?.results || [];
  const photos = [];
  for (const observation of observations) {
    for (const photo of observation.photos || []) {
      if (photo.license_code !== license || !photo.url) continue;
      photos.push({
        photoId: photo.id,
        observationId: observation.id,
        observationUrl: `https://www.inaturalist.org/observations/${observation.id}`,
        faves: observation.faves_count || 0,
        license: photo.license_code,
        attribution: photo.attribution || null,
        photographer: observation.user?.name || observation.user?.login || null,
        width: photo.original_dimensions?.width || null,
        height: photo.original_dimensions?.height || null,
        thumbUrl: photoVariant(photo.url, "medium"),
        originalUrl: photoVariant(photo.url, "original")
      });
    }
  }

  const totalObservations = response.data?.total_results || 0;
  return {
    taxon,
    license,
    page,
    totalObservations,
    hasMore: page * perPage < totalObservations,
    photos
  };
};

module.exports = {
  PICTURE_SIZES,
  REQUIRED_SIZES,
  INAT_LICENSES,
  normalizeName,
  pictureUrl,
  picturesRoot,
  pictureFilePath,
  getPicture,
  getPictureUrl,
  getPictureNames,
  describePicture,
  savePicture,
  removePicture,
  fetchWebsitePictureList,
  findInatPhotos
};
