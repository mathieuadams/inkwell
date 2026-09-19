// Normalises photos before upload: decodes HEIC/PNG/etc. (where the browser can),
// fixes orientation, caps the long edge, and re-encodes as JPEG under Bedrock's 3.75 MB image limit.
export const MAX_IMAGE_BYTES = 3_750_000;
export const MAX_PDF_BYTES = 4_500_000;
const MAX_EDGE = 2048;

export async function prepareFile(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > MAX_PDF_BYTES) throw new Error('PDFs must be under 4.5 MB. Try exporting one page.');
    return file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
  }
  const looksLikeImage = file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name);
  if (!looksLikeImage) throw new Error('Use a photo (JPG, PNG, HEIC) or a PDF.');

  let source = null;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await loadImage(URL.createObjectURL(file)).catch(() => null);
  }
  if (!source) throw new Error("This browser can't open that photo format. Save it as JPG and try again.");
  return toJpeg(source, source.naturalWidth || source.width, source.naturalHeight || source.height);
}

/** Renders an SVG string (e.g. the sample note) to a JPEG Blob. */
export async function rasterizeSvg(svg, width, height) {
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  return toJpeg(img, width, height);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function toJpeg(source, w, h) {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();

  let quality = 0.88;
  let blob = null;
  do {
    blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    quality -= 0.15;
  } while (blob && blob.size > MAX_IMAGE_BYTES && quality > 0.4);
  if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error('That photo is too large. Try a smaller one.');
  return blob;
}
