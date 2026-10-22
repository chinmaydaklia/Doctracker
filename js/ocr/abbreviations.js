// Reading aids for common prescription shorthand used in India (English and Hindi).
// These produce a *hint* shown next to the written text; the written text itself is
// what gets reviewed and saved. Unknown patterns return null — nothing is guessed.

const FREQ = [
  [/^(od|o\.d\.?|qd|once daily|once a day)$/i, "once daily", 1],
  [/^(bd|b\.d\.?|bid|b\.i\.d\.?|twice daily|twice a day)$/i, "twice daily", 2],
  [/^(tds|t\.d\.s\.?|tid|t\.i\.d\.?|thrice daily)$/i, "three times daily", 3],
  [/^(qid|q\.i\.d\.?|qds|four times daily)$/i, "four times daily", 4],
  [/^(hs|h\.s\.?|at bedtime|bedtime)$/i, "at bedtime", 1],
  [/^(sos|s\.o\.s\.?|prn|p\.r\.n\.?|as needed|when required)$/i, "only when needed", null],
  [/^(stat)$/i, "immediately, once", null],
  [/^(ac|a\.c\.?)$/i, "before food", null],
  [/^(pc|p\.c\.?)$/i, "after food", null],
  [/^(q4h|4 hourly)$/i, "every 4 hours", 6],
  [/^(q6h|6 hourly)$/i, "every 6 hours", 4],
  [/^(q8h|8 hourly)$/i, "every 8 hours", 3],
  [/^(weekly|once weekly|once a week)$/i, "once a week", null],
  [/^(alt(ernate)? days?|ad|eod)$/i, "on alternate days", null],
];

const HINDI = [
  [/(सुबह|subah|subeh)/i, "morning"],
  [/(दोपहर|dopahar|dophar)/i, "afternoon"],
  [/(शाम|shaam|sham)/i, "evening"],
  [/(रात|raat|rat\b)/i, "night"],
  [/(खाने\s*(के|से)\s*पहले|khane\s*(ke|se)\s*pehle|khali\s*pet|खाली\s*पेट)/i, "before food / empty stomach"],
  [/(खाने\s*के\s*बाद|khane\s*ke\s*baad|khana\s*khane\s*ke\s*baad)/i, "after food"],
  [/(दिन\s*में\s*एक\s*बार|din\s*me(in)?\s*ek\s*baar)/i, "once daily"],
  [/(दिन\s*में\s*दो\s*बार|din\s*me(in)?\s*do\s*baar)/i, "twice daily"],
  [/(दिन\s*में\s*तीन\s*बार|din\s*me(in)?\s*teen\s*baar)/i, "three times daily"],
  [/(ज़रूरत\s*पर|जरूरत\s*पर|zarurat\s*(pad(ne)?)?\s*par)/i, "only when needed"],
];

const PART = { "0": 0, "1": 1, "2": 2, "½": 0.5, "1/2": 0.5, "¼": 0.25, "1½": 1.5 };
const SLOTS = ["morning", "afternoon", "night"];

// "1-0-1", "1-1-1", "0-0-1", "½-0-½", "1-0-0-1"
function dosePattern(t) {
  const m = t.replace(/\s/g, "").match(/^(1½|1\/2|½|¼|[0-2])(?:[-–x×](1½|1\/2|½|¼|[0-2])){2,3}$/);
  if (!m) return null;
  const parts = t.replace(/\s/g, "").split(/[-–x×]/).map((p) => PART[p]);
  if (parts.some((p) => p === undefined)) return null;
  const slots = parts.length === 4 ? ["morning", "afternoon", "evening", "night"] : SLOTS;
  const text = parts.map((p, i) => (p ? `${p} ${slots[i]}` : null)).filter(Boolean).join(", ");
  return { meaning: text || "none", perDay: parts.reduce((a, b) => a + b, 0) };
}

export function interpretFrequency(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const dp = dosePattern(t);
  if (dp) return dp;
  const parts = t.split(/[\s,;]+/).filter(Boolean);
  const out = [];
  let perDay = null;
  for (const p of parts) {
    const hit = FREQ.find(([re]) => re.test(p));
    if (hit) {
      out.push(hit[1]);
      if (hit[2]) perDay = hit[2];
    }
  }
  for (const [re, meaning] of HINDI) if (re.test(t) && !out.includes(meaning)) out.push(meaning);
  return out.length ? { meaning: out.join(", "), perDay } : null;
}

// "x 5d", "5 days", "5/7" (days), "2/52" (weeks), "1/12" (months), "× 1 month", "5 दिन"
export function interpretDuration(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  let m = t.match(/^(?:x|×|for)?\s*(\d+)\s*\/\s*(7|52|12)$/);
  if (m) return { meaning: `${m[1]} ${{ 7: "day", 52: "week", 12: "month" }[m[2]]}${m[1] === "1" ? "" : "s"}`, days: Number(m[1]) * { 7: 1, 52: 7, 12: 30 }[m[2]] };
  m = t.match(/^(?:x|×|for)?\s*(\d+)\s*(d|day|days|दिन|din|w|wk|wks|week|weeks|हफ्ते|hafte|m|mo|month|months|महीने|mahine)\.?$/);
  if (m) {
    const u = m[2];
    const unit = /^(d|day|days|दिन|din)$/.test(u) ? "day" : /^(w|wk|wks|week|weeks|हफ्ते|hafte)$/.test(u) ? "week" : "month";
    const n = Number(m[1]);
    return { meaning: `${n} ${unit}${n === 1 ? "" : "s"}`, days: n * { day: 1, week: 7, month: 30 }[unit] };
  }
  if (/^(continue|cont\.?|to continue|chalu rakhe|चालू\s*रखें)$/.test(t)) return { meaning: "continue (no end date written)", days: null };
  return null;
}

// Clinical shorthand often seen in headings.
export const SECTION_SHORTHAND = {
  "c/o": "complains of (chief complaints)",
  "k/c/o": "known case of (comorbidity)",
  "h/o": "history of",
  "o/e": "on examination",
  "rx": "prescription",
  "adv": "advice",
  "inv": "investigations",
  "r/v": "review (follow-up)",
  "f/u": "follow-up",
  "s/b": "seen by",
  "?": "query / suspected",
};
