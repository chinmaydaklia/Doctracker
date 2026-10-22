// Measures handwriting-reading accuracy on YOUR OWN anonymised prescriptions.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run ocr:eval -- path/to/folder
//
// The folder holds images (jpg/png/webp/pdf) and, for each, a ground-truth file with the
// same name + ".json", written by a doctor from the paper:
//   { "medications": [{ "name": "Tab Dolo 650", "strength": "", "dose": "1 tab",
//                        "frequency": "1-0-1", "duration": "x 3d" }],
//     "diagnoses": ["? Viral fever"], "complaints": ["fever"], "patient": { "name": "", "age": "" } }
// Leave a value "" if it is not on the paper. Compare as written (abbreviations kept).
//
// Every image is sent to the Anthropic API (billed to the key). Use anonymised or
// consented images only. Nothing is written to the app's database.
//
// Reported per field: exact-match accuracy, character error rate (CER: how far off the
// readings are, so near-misses count partly), and the dangerous case — a WRONG value the reader
// marked clear with confidence >= 0.8 ("confident errors"), which the app would not flag.

import { readFile, readdir } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { readPrescription } from "../js/ocr/claude.js";

const dir = process.argv[2];
if (!dir || !process.env.ANTHROPIC_API_KEY) {
  console.error("Usage: ANTHROPIC_API_KEY=... node scripts/ocr-eval.js <folder>");
  process.exit(1);
}
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".pdf": "application/pdf" };
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]$/, "").trim();
const client = new Anthropic();
// Character error rate: edits needed to turn the reading into the truth, per character.
function cer(got, want) {
  const a = norm(got), b = norm(want);
  if (!b) return a ? 1 : 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return Math.min(1, d[a.length][b.length] / b.length);
}
const stats = {};
const tally = (field, expected, reading) => {
  const t = (stats[field] ||= { n: 0, correct: 0, flagged: 0, confidentWrong: 0, missed: 0, cer: 0 });
  if (!norm(expected) && !reading?.text) return;
  t.n++;
  t.cer += cer(reading?.text, expected);
  const flagged = !reading || reading.legibility !== "clear" || reading.confidence < 0.8 || (reading.alternatives || []).length > 0;
  if (reading && norm(reading.text) === norm(expected)) t.correct++;
  else if (!reading || !reading.text) t.missed++;
  else if (!flagged) t.confidentWrong++;
  if (flagged) t.flagged++;
};

const files = (await readdir(dir)).filter((f) => MIME[extname(f).toLowerCase()]);
console.log(`Reading ${files.length} prescriptions…`);
for (const f of files) {
  const truth = JSON.parse(await readFile(join(dir, f + ".json"), "utf8").catch(() => readFile(join(dir, basename(f, extname(f)) + ".json"), "utf8")));
  const bytes = new Uint8Array(await readFile(join(dir, f)));
  try {
    const { extraction: ex } = await readPrescription({ client, bytes, mime: MIME[extname(f).toLowerCase()] });
    (truth.medications || []).forEach((m, i) => {
      const got = ex.medications[i];
      for (const k of ["name", "strength", "dose", "frequency", "duration"]) tally("medicine " + k, m[k], got && got[k]);
    });
    (truth.diagnoses || []).forEach((d, i) => tally("diagnosis", d, ex.diagnoses[i]?.diagnosis));
    (truth.complaints || []).forEach((c, i) => tally("complaint", c, ex.chief_complaints[i]?.complaint));
    if (truth.patient) for (const k of ["name", "age"]) tally("patient " + k, truth.patient[k], ex.patient[k]);
    console.log(`  ✓ ${f}: ${ex.medications.length} medicines, quality ${ex.document.image_quality}`);
  } catch (e) {
    console.log(`  ✗ ${f}: ${e.message}`);
  }
}
console.log("\nField               n   correct    CER  flagged  missed  CONFIDENT ERRORS");
for (const [k, t] of Object.entries(stats)) {
  console.log(`${k.padEnd(18)} ${String(t.n).padStart(3)}   ${String(Math.round((100 * t.correct) / Math.max(1, t.n))).padStart(5)}%  ${String(Math.round((100 * t.cer) / Math.max(1, t.n))).padStart(4)}%  ${String(t.flagged).padStart(7)}  ${String(t.missed).padStart(6)}  ${String(t.confidentWrong).padStart(6)}`);
}
console.log("\nConfident errors are wrong values the app would show as clear — any non-zero count there means: keep reviewing every field against the image.");
