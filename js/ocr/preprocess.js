// Image clean-up in the browser (canvas): rotation, 4-corner crop with perspective
// correction, brightness/contrast/greyscale and optional adaptive "ink" threshold.
// The original image is never modified; this produces a new enhanced JPEG.

import { quadSize, warpPerspective, adjust, adaptiveThreshold, fullQuad } from "./geometry.js";

const WORK_MAX = 2400; // working resolution (long side), keeps phones responsive
export const OUTPUT_MAX = 2000; // long side sent for reading

export async function loadBitmap(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  // imageOrientation applies the camera's EXIF rotation.
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

// Draw the bitmap rotated by `rotation` (multiple of 90) + `fine` degrees, scaled to WORK_MAX.
export function rotatedCanvas(bitmap, rotation = 0, fine = 0) {
  const s = Math.min(1, WORK_MAX / Math.max(bitmap.width, bitmap.height));
  const w = bitmap.width * s;
  const h = bitmap.height * s;
  const rad = ((rotation + fine) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const cw = Math.round(w * cos + h * sin);
  const ch = Math.round(w * sin + h * cos);
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, cw, ch);
  g.translate(cw / 2, ch / 2);
  g.rotate(rad);
  g.drawImage(bitmap, -w / 2, -h / 2, w, h);
  return c;
}

// ops: { rotation, fine, quad (points in rotated-canvas coordinates, TL TR BR BL),
//        brightness, contrast, grayscale, threshold }
export async function renderEnhanced(bitmap, ops) {
  const base = rotatedCanvas(bitmap, ops.rotation || 0, ops.fine || 0);
  const quad = ops.quad || fullQuad(base.width, base.height);
  const size = quadSize(quad, OUTPUT_MAX);
  const src = base.getContext("2d").getImageData(0, 0, base.width, base.height);
  let img = warpPerspective(src, quad, size);
  adjust(img, { brightness: ops.brightness || 0, contrast: ops.contrast || 0, grayscale: !!ops.grayscale });
  if (ops.threshold) adaptiveThreshold(img, { radius: Math.max(8, Math.round(Math.max(size.width, size.height) / 80)), offset: 12 });
  const out = document.createElement("canvas");
  out.width = size.width;
  out.height = size.height;
  out.getContext("2d").putImageData(new ImageData(img.data, size.width, size.height), 0, 0);
  const blob = await new Promise((r) => out.toBlob(r, "image/jpeg", 0.9));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg", width: size.width, height: size.height, canvas: out };
}
