window.PictureTools = (() => {
  const token = new URLSearchParams(location.search).get("token") || "";
  let config = { sizes: [64, 128, 256, 512, 1024], requiredSizes: [64, 128, 256], licenses: ["cc0", "cc-by", "cc-by-sa"] };

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const api = async (path, options = {}) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(path, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
      });
      if (response.status === 429 && attempt < 20) {
        const reset = Number(response.headers.get("RateLimit-Reset")) || 10;
        await pause(Math.min(Math.max(reset, 2), 60) * 1000);
        continue;
      }
      if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try { message = (await response.json()).error || message; } catch {}
        throw new Error(message);
      }
      return response;
    }
  };
  const apiJson = async (path, options) => (await api(path, options)).json();
  const postJson = (path, body) => apiJson(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });

  const loadConfig = async () => {
    try { config = await apiJson("/admin/pictures/config"); } catch {}
    return config;
  };

  const sizesFor = (side) => config.sizes.filter((size) => size <= side || config.requiredSizes.includes(size));

  const loadImage = (blob) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The browser could not read this image"));
    };
    image.src = url;
  });

  const fetchPhoto = async (url) => {
    let response;
    try {
      response = await fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
    } catch {
      throw new Error(`The browser could not download ${url}`);
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${new URL(url).hostname}`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error(`${new URL(url).hostname} did not return an image`);
    return blob;
  };

  const renderSize = (image, crop, size) => {
    const side = crop.side;
    let canvas = document.createElement("canvas");
    let edge = Math.max(size, Math.min(Math.round(side), 4096));
    canvas.width = canvas.height = edge;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, edge, edge);
    ctx.drawImage(image, crop.x, crop.y, side, side, 0, 0, edge, edge);

    while (edge / 2 >= size) {
      const next = Math.round(edge / 2);
      const half = document.createElement("canvas");
      half.width = half.height = next;
      const halfCtx = half.getContext("2d");
      halfCtx.imageSmoothingQuality = "high";
      halfCtx.drawImage(canvas, 0, 0, edge, edge, 0, 0, next, next);
      canvas = half;
      edge = next;
    }

    if (edge !== size) {
      const final = document.createElement("canvas");
      final.width = final.height = size;
      const finalCtx = final.getContext("2d");
      finalCtx.imageSmoothingQuality = "high";
      finalCtx.drawImage(canvas, 0, 0, edge, edge, 0, 0, size, size);
      canvas = final;
    }

    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode the picture")), "image/jpeg", 0.9));
  };

  const MAX_FULL_SIZE = 8192;

  const fullSizeFor = (side) => {
    const full = Math.min(Math.round(side), MAX_FULL_SIZE);
    return full > Math.max(...sizesFor(side)) ? full : null;
  };

  const renderFull = (image, crop, size) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(image, crop.x, crop.y, crop.side, crop.side, 0, 0, size, size);
    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode the picture")), "image/jpeg", 0.9));
  };

  const centeredSquare = (image) => {
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    return {
      side,
      x: Math.floor((image.naturalWidth - side) / 2),
      y: Math.floor((image.naturalHeight - side) / 2)
    };
  };

  const savePicture = async (name, image, crop, source, extraMeta = {}) => {
    const form = new FormData();
    form.append("name", name);
    form.append("meta", JSON.stringify({
      ...extraMeta,
      source,
      crop: { ...crop, sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight }
    }));
    for (const size of sizesFor(crop.side)) {
      form.append(`size-${size}`, await renderSize(image, crop, size), `${size}.jpg`);
    }
    const full = fullSizeFor(crop.side);
    if (full) form.append("full", await renderFull(image, crop, full), `${full}.jpg`);
    return apiJson("/admin/pictures/save", { method: "POST", body: form });
  };

  return {
    get config() { return config; },
    api,
    apiJson,
    postJson,
    loadConfig,
    sizesFor,
    fullSizeFor,
    loadImage,
    fetchPhoto,
    centeredSquare,
    savePicture
  };
})();
