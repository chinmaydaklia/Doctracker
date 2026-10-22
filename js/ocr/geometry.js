// Pure image-geometry helpers for scan clean-up (no DOM): perspective correction
// (4-point homography), contrast mapping and output sizing. Unit-tested in Node.

// Solve A·x = b (n×n) by Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error("Corner points are degenerate (three in a line or overlapping).");
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Homography H mapping src[i] -> dst[i] (4 point pairs, each {x, y}). Returns 3×3 row-major [9].
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

// Output size for a quadrilateral (TL, TR, BR, BL): average of opposite edge lengths,
// scaled so the longer side is at most maxSide.
export function quadSize(q, maxSide = 2000) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = (d(q[0], q[1]) + d(q[3], q[2])) / 2;
  let h = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

// Inverse warp: for each output pixel, sample the source through H⁻¹ (bilinear).
// src: {data: Uint8ClampedArray RGBA, width, height}. Returns new RGBA ImageData-like object.
export function warpPerspective(src, quad, out) {
  const Hinv = homography(
    [{ x: 0, y: 0 }, { x: out.width - 1, y: 0 }, { x: out.width - 1, y: out.height - 1 }, { x: 0, y: out.height - 1 }],
    quad,
  );
  const dst = new Uint8ClampedArray(out.width * out.height * 4);
  const { data, width: W, height: Hh } = src;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const p = applyH(Hinv, x, y);
      const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
      const o = (y * out.width + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= Hh - 1) {
        dst[o] = dst[o + 1] = dst[o + 2] = 255;
        dst[o + 3] = 255;
        continue;
      }
      const fx = p.x - x0, fy = p.y - y0;
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      for (let c = 0; c < 4; c++) {
        dst[o + c] = data[i00 + c] * (1 - fx) * (1 - fy) + data[i10 + c] * fx * (1 - fy) + data[i01 + c] * (1 - fx) * fy + data[i11 + c] * fx * fy;
      }
    }
  }
  return { data: dst, width: out.width, height: out.height };
}

// Brightness (-100..100), contrast (-100..100), optional grayscale, in place.
export function adjust(img, { brightness = 0, contrast = 0, grayscale = false } = {}) {
  const c = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const b = brightness * 2.55;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], bl = d[i + 2];
    if (grayscale) r = g = bl = 0.299 * r + 0.587 * g + 0.114 * bl;
    d[i] = c * (r - 128) + 128 + b;
    d[i + 1] = c * (g - 128) + 128 + b;
    d[i + 2] = c * (bl - 128) + 128 + b;
  }
  return img;
}

// Local-mean ("adaptive") thresholding to make ink stand out on uneven paper / shadows.
// Uses an integral image so it is O(pixels).
export function adaptiveThreshold(img, { radius = 15, offset = 10 } = {}) {
  const { width: W, height: H, data } = img;
  const gray = new Float64Array(W * H);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const integ = new Float64Array((W + 1) * (H + 1));
  for (let y = 1; y <= H; y++) {
    let row = 0;
    for (let x = 1; x <= W; x++) {
      row += gray[(y - 1) * W + (x - 1)];
      integ[y * (W + 1) + x] = integ[(y - 1) * (W + 1) + x] + row;
    }
  }
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(H - 1, y + radius);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(W - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s = integ[(y1 + 1) * (W + 1) + (x1 + 1)] - integ[y0 * (W + 1) + (x1 + 1)] - integ[(y1 + 1) * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
      const v = gray[y * W + x] < s / area - offset ? 0 : 255;
      const o = (y * W + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  }
  return img;
}

// Corners of the full image after an optional rotation in degrees (for default crop).
export function fullQuad(width, height) {
  return [{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }];
}

// ------------------------------------------------------------ page detection
// Finds the paper in a photo so the four corners can be pre-set (the doctor can
// still drag them). Approach: greyscale → Otsu threshold (paper is the bright
// region) → close small gaps → largest bright connected region → its corners as the
// extreme points of x+y and x−y (top-left = min x+y, bottom-right = max x+y,
// top-right = max x−y, bottom-left = min x−y). Returns corners in the input image's
// coordinates, or null when no clear page boundary is found (e.g. the page already
// fills the photo, or the background is as bright as the paper).

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return { thr, separation: best / (total * total) };
}

export function detectPage(img, { maxSide = 360 } = {}) {
  const { width: W0, height: H0, data } = img;
  const s = Math.min(1, maxSide / Math.max(W0, H0));
  const W = Math.max(8, Math.round(W0 * s)), H = Math.max(8, Math.round(H0 * s));
  const gray = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (Math.min(H0 - 1, Math.floor(y / s)) * W0 + Math.min(W0 - 1, Math.floor(x / s))) * 4;
      gray[y * W + x] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }
  }
  const { thr, separation } = otsu(gray);
  if (separation < 200) return null; // no real bright/dark split
  // Bright mask, then close gaps left by ink with a box filter (radius r).
  const r = Math.max(2, Math.round(Math.max(W, H) / 60));
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = gray[i] > thr ? 1 : 0;
  const integ = new Uint32Array((W + 1) * (H + 1));
  for (let y = 1; y <= H; y++) {
    let row = 0;
    for (let x = 1; x <= W; x++) {
      row += mask[(y - 1) * W + (x - 1)];
      integ[y * (W + 1) + x] = integ[(y - 1) * (W + 1) + x] + row;
    }
  }
  const closed = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const c = integ[(y1 + 1) * (W + 1) + (x1 + 1)] - integ[y0 * (W + 1) + (x1 + 1)] - integ[(y1 + 1) * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
      closed[y * W + x] = c > n * 0.35 ? 1 : 0;
    }
  }
  // Largest connected bright region (4-connectivity, iterative flood fill).
  const label = new Int32Array(W * H);
  let bestId = 0, bestSize = 0, id = 0;
  const stack = new Int32Array(W * H);
  for (let i = 0; i < closed.length; i++) {
    if (!closed[i] || label[i]) continue;
    id++;
    let sp = 0, size = 0;
    stack[sp++] = i;
    label[i] = id;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % W, y = (p - x) / W;
      if (x > 0 && closed[p - 1] && !label[p - 1]) (label[p - 1] = id), (stack[sp++] = p - 1);
      if (x < W - 1 && closed[p + 1] && !label[p + 1]) (label[p + 1] = id), (stack[sp++] = p + 1);
      if (y > 0 && closed[p - W] && !label[p - W]) (label[p - W] = id), (stack[sp++] = p - W);
      if (y < H - 1 && closed[p + W] && !label[p + W]) (label[p + W] = id), (stack[sp++] = p + W);
    }
    if (size > bestSize) (bestSize = size), (bestId = id);
  }
  const area = bestSize / (W * H);
  if (area < 0.2 || area > 0.97) return null; // too small to be the page, or page fills the frame
  let tl, tr, br, bl;
  let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
  for (let p = 0; p < label.length; p++) {
    if (label[p] !== bestId) continue;
    const x = p % W, y = (p - x) / W;
    const sm = x + y, df = x - y;
    if (sm < minS) (minS = sm), (tl = { x, y });
    if (sm > maxS) (maxS = sm), (br = { x, y });
    if (df > maxD) (maxD = df), (tr = { x, y });
    if (df < minD) (minD = df), (bl = { x, y });
  }
  const quad = [tl, tr, br, bl].map((p) => ({ x: Math.min(W0 - 1, (p.x + 0.5) / s), y: Math.min(H0 - 1, (p.y + 0.5) / s) }));
  // Reject degenerate shapes (corners collapsed or a sliver).
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  if (Math.min(d(quad[0], quad[1]), d(quad[1], quad[2]), d(quad[2], quad[3]), d(quad[3], quad[0])) < 0.15 * Math.max(W0, H0)) return null;
  return quad;
}
