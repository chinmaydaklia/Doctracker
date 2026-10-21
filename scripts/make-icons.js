// Generates the PNG app icons (no dependencies): teal tile with a white medical cross
// over a rising bar line. Run: npm run icons
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const TEAL = [15, 92, 110, 255];
const WHITE = [255, 255, 255, 255];
const AMBER = [245, 177, 66, 255];
function draw(scale, rounded) {
  return (u, v) => {
    if (rounded) {
      const r = 0.18, cx = Math.min(Math.max(u, r), 1 - r), cy = Math.min(Math.max(v, r), 1 - r);
      if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return [0, 0, 0, 0];
    }
    const x = 0.5 + (u - 0.5) / scale, y = 0.5 + (v - 0.5) / scale;
    const cross = (Math.abs(x - 0.5) < 0.09 && y > 0.2 && y < 0.62) || (Math.abs(y - 0.41) < 0.09 && x > 0.29 && x < 0.71);
    if (cross) return WHITE;
    const bars = [[0.27, 0.74], [0.41, 0.69], [0.55, 0.64], [0.69, 0.59]];
    for (const [bx, top] of bars) if (x > bx && x < bx + 0.09 && y > top && y < 0.82) return AMBER;
    return TEAL;
  };
}
writeFileSync("icons/icon-192.png", png(192, draw(1, true)));
writeFileSync("icons/icon-512.png", png(512, draw(1, true)));
writeFileSync("icons/icon-maskable-512.png", png(512, draw(0.78, false)));
console.log("icons written");
