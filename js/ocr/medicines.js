// Medicine reference catalogue for checking names read from prescriptions.
// Matching NEVER replaces what was written: a near-miss is offered as a suggestion only.
// This list is a starter set of commonly prescribed Indian brands and generics; the
// doctor's favourites and additions extend it. It is not a drug database (no doses,
// interactions or availability) and an entry here is not a recommendation.

// [brand, generic composition]
export const BRANDS = [
  ["Dolo", "paracetamol"], ["Crocin", "paracetamol"], ["Calpol", "paracetamol"], ["Pacimol", "paracetamol"],
  ["Combiflam", "ibuprofen + paracetamol"], ["Brufen", "ibuprofen"], ["Meftal", "mefenamic acid"], ["Meftal-Spas", "mefenamic acid + dicyclomine"],
  ["Zerodol", "aceclofenac"], ["Zerodol-P", "aceclofenac + paracetamol"], ["Zerodol-SP", "aceclofenac + paracetamol + serratiopeptidase"], ["Hifenac", "aceclofenac"],
  ["Voveran", "diclofenac"], ["Ultracet", "tramadol + paracetamol"], ["Cyclopam", "dicyclomine + paracetamol"],
  ["Pan", "pantoprazole"], ["Pan-D", "pantoprazole + domperidone"], ["Pantocid", "pantoprazole"], ["Pantop", "pantoprazole"],
  ["Omez", "omeprazole"], ["Razo", "rabeprazole"], ["Rablet", "rabeprazole"], ["Nexpro", "esomeprazole"],
  ["Rantac", "ranitidine"], ["Aciloc", "ranitidine"], ["Famocid", "famotidine"],
  ["Ondem", "ondansetron"], ["Emeset", "ondansetron"], ["Vomikind", "ondansetron"], ["Domstal", "domperidone"], ["Perinorm", "metoclopramide"],
  ["Sporlac", "lactic acid bacillus"], ["Econorm", "saccharomyces boulardii"], ["Electral", "oral rehydration salts"],
  ["Duphalac", "lactulose"], ["Cremaffin", "liquid paraffin + milk of magnesia"], ["Udiliv", "ursodeoxycholic acid"],
  ["Norflox", "norfloxacin"], ["Norflox-TZ", "norfloxacin + tinidazole"], ["Ciplox", "ciprofloxacin"], ["Cifran", "ciprofloxacin"],
  ["Oflox", "ofloxacin"], ["Zenflox", "ofloxacin"], ["O2", "ofloxacin + ornidazole"], ["Glevo", "levofloxacin"], ["Levoflox", "levofloxacin"],
  ["Metrogyl", "metronidazole"], ["Flagyl", "metronidazole"], ["Tiniba", "tinidazole"],
  ["Augmentin", "amoxicillin + clavulanic acid"], ["Moxclav", "amoxicillin + clavulanic acid"], ["Clavam", "amoxicillin + clavulanic acid"],
  ["Mox", "amoxicillin"], ["Novamox", "amoxicillin"], ["Azithral", "azithromycin"], ["Azee", "azithromycin"],
  ["Taxim-O", "cefixime"], ["Zifi", "cefixime"], ["Mahacef", "cefixime"], ["Monocef", "ceftriaxone"], ["Ceftum", "cefuroxime"],
  ["Doxt", "doxycycline"], ["Martifur", "nitrofurantoin"], ["Forcan", "fluconazole"], ["Zocon", "fluconazole"],
  ["Zentel", "albendazole"], ["Ivermectol", "ivermectin"],
  ["Allegra", "fexofenadine"], ["Cetzine", "cetirizine"], ["Okacet", "cetirizine"], ["Alerid", "cetirizine"],
  ["Levocet", "levocetirizine"], ["Teczine", "levocetirizine"], ["Xyzal", "levocetirizine"], ["Avil", "pheniramine"],
  ["Montair", "montelukast"], ["Montair-LC", "montelukast + levocetirizine"], ["Montek-LC", "montelukast + levocetirizine"],
  ["Asthalin", "salbutamol"], ["Levolin", "levosalbutamol"], ["Duolin", "levosalbutamol + ipratropium"], ["Deriphyllin", "etofylline + theophylline"],
  ["Budecort", "budesonide"], ["Foracort", "formoterol + budesonide"], ["Seroflo", "salmeterol + fluticasone"],
  ["Wysolone", "prednisolone"], ["Omnacortil", "prednisolone"], ["Medrol", "methylprednisolone"], ["Dexona", "dexamethasone"],
  ["Glycomet", "metformin"], ["Glycomet-GP", "metformin + glimepiride"], ["Amaryl", "glimepiride"], ["Glynase", "glipizide"],
  ["Januvia", "sitagliptin"], ["Istavel", "sitagliptin"], ["Galvus", "vildagliptin"], ["Jardiance", "empagliflozin"], ["Forxiga", "dapagliflozin"],
  ["Lantus", "insulin glargine"], ["Mixtard", "human insulin (premixed)"], ["Huminsulin", "human insulin"],
  ["Telma", "telmisartan"], ["Telma-H", "telmisartan + hydrochlorothiazide"], ["Telma-AM", "telmisartan + amlodipine"],
  ["Amlong", "amlodipine"], ["Amlokind", "amlodipine"], ["Stamlo", "amlodipine"], ["Amlopres", "amlodipine"],
  ["Losar", "losartan"], ["Repace", "losartan"], ["Cilacar", "cilnidipine"], ["Concor", "bisoprolol"], ["Metolar", "metoprolol"],
  ["Aten", "atenolol"], ["Tenormin", "atenolol"], ["Envas", "enalapril"], ["Cardace", "ramipril"],
  ["Aldactone", "spironolactone"], ["Lasix", "furosemide"], ["Dytor", "torsemide"],
  ["Atorva", "atorvastatin"], ["Storvas", "atorvastatin"], ["Rosuvas", "rosuvastatin"], ["Rozavel", "rosuvastatin"],
  ["Ecosprin", "aspirin"], ["Ecosprin-AV", "aspirin + atorvastatin"], ["Clopitab", "clopidogrel"], ["Clopilet", "clopidogrel"], ["Brilinta", "ticagrelor"],
  ["Sorbitrate", "isosorbide dinitrate"], ["Nikoran", "nicorandil"], ["Lanoxin", "digoxin"],
  ["Thyronorm", "levothyroxine"], ["Eltroxin", "levothyroxine"], ["Thyrox", "levothyroxine"], ["Neo-Mercazole", "carbimazole"],
  ["Shelcal", "calcium + vitamin D3"], ["Calcirol", "cholecalciferol"], ["Uprise-D3", "cholecalciferol"], ["Becosules", "B-complex + vitamin C"],
  ["Neurobion Forte", "vitamin B1 + B6 + B12"], ["Limcee", "vitamin C"], ["Zincovit", "multivitamin + zinc"], ["Folvite", "folic acid"],
  ["Livogen", "ferrous fumarate + folic acid"], ["Orofer XT", "ferrous ascorbate + folic acid"], ["Nurokind", "methylcobalamin"],
  ["Pregalin", "pregabalin"], ["Gabapin", "gabapentin"], ["Levipil", "levetiracetam"], ["Eptoin", "phenytoin"], ["Tegretol", "carbamazepine"], ["Valparin", "sodium valproate"],
  ["Nexito", "escitalopram"], ["Restyl", "alprazolam"], ["Rivotril", "clonazepam"], ["Zolfresh", "zolpidem"],
  ["Urimax", "tamsulosin"], ["Zyloric", "allopurinol"], ["Betnovate", "betamethasone"], ["Candid", "clotrimazole"], ["T-Bact", "mupirocin"], ["Soframycin", "framycetin"],
  ["Liv 52", "herbal preparation"],
];

export const GENERICS = [
  "paracetamol", "ibuprofen", "diclofenac", "aceclofenac", "mefenamic acid", "tramadol", "serratiopeptidase",
  "pantoprazole", "omeprazole", "rabeprazole", "esomeprazole", "ranitidine", "famotidine", "ondansetron", "domperidone", "metoclopramide",
  "dicyclomine", "loperamide", "oral rehydration salts", "lactulose", "ursodeoxycholic acid",
  "norfloxacin", "ciprofloxacin", "ofloxacin", "levofloxacin", "ornidazole", "tinidazole", "metronidazole",
  "amoxicillin", "amoxicillin + clavulanic acid", "azithromycin", "cefixime", "cefuroxime", "cefpodoxime", "ceftriaxone", "doxycycline", "nitrofurantoin",
  "fluconazole", "albendazole", "ivermectin",
  "cetirizine", "levocetirizine", "fexofenadine", "montelukast", "chlorpheniramine", "pheniramine",
  "salbutamol", "levosalbutamol", "ipratropium", "budesonide", "formoterol", "theophylline",
  "prednisolone", "methylprednisolone", "dexamethasone", "hydrocortisone",
  "metformin", "glimepiride", "gliclazide", "glipizide", "sitagliptin", "vildagliptin", "teneligliptin", "empagliflozin", "dapagliflozin", "insulin",
  "telmisartan", "losartan", "olmesartan", "amlodipine", "cilnidipine", "metoprolol", "atenolol", "bisoprolol", "enalapril", "ramipril",
  "hydrochlorothiazide", "chlorthalidone", "furosemide", "torsemide", "spironolactone",
  "atorvastatin", "rosuvastatin", "aspirin", "clopidogrel", "ticagrelor", "isosorbide dinitrate", "isosorbide mononitrate", "nicorandil", "digoxin", "warfarin",
  "levothyroxine", "carbimazole", "calcium", "cholecalciferol", "vitamin D3", "methylcobalamin", "folic acid", "ferrous ascorbate", "B-complex", "vitamin C", "zinc",
  "pregabalin", "gabapentin", "levetiracetam", "phenytoin", "carbamazepine", "sodium valproate",
  "escitalopram", "sertraline", "alprazolam", "clonazepam", "zolpidem",
  "tamsulosin", "allopurinol", "febuxostat", "colchicine", "betamethasone", "clotrimazole", "mupirocin",
];

const FORM_WORDS = /\b(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syp|syr|syrup|susp|suspension|inj|injection|oint|ointment|cream|gel|drops?|gtt|inh|inhaler|rotacap|respule|neb|sachet|lotion|soln|solution|mouthwash)\b\.?/gi;
const STRENGTH = /\b\d+(\.\d+)?\s*(mg|mcg|µg|g|gm|ml|iu|units?|%|mg\/ml)?\b/gi;

export function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[™®]/g, "")
    .replace(/^\s*(t|c|s|i)\.\s*/, " ") // "T. Dolo", "C. Becosules", "S. Ascoril", "I. Monocef"
    .replace(FORM_WORDS, " ")
    .replace(/[-_/.,()+]/g, " ")
    .replace(STRENGTH, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m + n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export function buildCatalogue(extra = []) {
  const entries = [];
  for (const [brand, generic] of BRANDS) entries.push({ name: brand, generic, kind: "brand" });
  for (const g of GENERICS) entries.push({ name: g, generic: g, kind: "generic" });
  for (const x of extra) if (x && x.name) entries.push({ name: x.name, generic: x.generic || "", kind: x.kind || "custom" });
  return entries.map((e) => ({ ...e, key: normalizeName(e.name) })).filter((e) => e.key);
}

let DEFAULT;
// Result: { status: "exact" | "partial" | "similar" | "none" | "empty", match?, suggestions[] }.
// "similar" means the written name is close to known names: the doctor must decide;
// the written name is kept unchanged.
export function matchMedicine(written, catalogue) {
  const cat = catalogue || (DEFAULT ||= buildCatalogue());
  const key = normalizeName(written);
  if (!key) return { status: "empty", suggestions: [] };
  const exact = cat.find((e) => e.key === key);
  if (exact) return { status: "exact", match: exact, suggestions: [] };
  // "Dolo 650" -> "dolo"; "Pan D 40" -> "pan d": try the leading words.
  const words = key.split(" ");
  for (let n = words.length - 1; n >= 1; n--) {
    const pre = words.slice(0, n).join(" ");
    const hit = cat.find((e) => e.key === pre);
    // A variant ("Dolo Cold", "Augmentin Duo") may be a different product: "partial", never "exact".
    if (hit) return { status: "partial", match: hit, suggestions: [], note: `starts with "${hit.name}" (${hit.generic}); also written: "${words.slice(n).join(" ")}" — check the exact product` };
  }
  const scored = cat
    .map((e) => ({ e, d: lev(key, e.key) }))
    .filter(({ e, d }) => d <= Math.max(1, Math.floor(Math.min(key.length, e.key.length) / 4)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ e }) => e);
  return scored.length ? { status: "similar", suggestions: scored } : { status: "none", suggestions: [] };
}
