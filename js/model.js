// Domain constants, store names and example configuration.

export const DB_SCHEMA_VERSION = 1; // IndexedDB object-store layout
export const DATA_FORMAT = 1; // backup file format

export const STORES = [
  "locations",
  "rates",
  "payers",
  "agreements",
  "sessions",
  "visits",
  "payments",
  "allocations",
  "adjustments",
  "settlements",
  "audit",
  "backups",
  "meta",
  "snapshots",
];
// Stores that make up "the records" (exported, counted, checksummed).
export const DATA_STORES = STORES.filter((s) => s !== "snapshots");

export const SESSION_NAMES = ["morning", "afternoon", "evening"];

export const SESSION_MODES = {
  summary: "Summary only",
  individual: "Individual entries",
  summary_recon: "Summary + individual reconciliation",
};

export const ARRANGEMENTS = {
  direct: "Patients pay me directly",
  hospital: "Hospital collects, settles with me",
  mixed: "Mixed (choose per session)",
};

export const LOCATION_KINDS = {
  hospital: "Hospital",
  clinic: "Own clinic",
  village: "Village OPD",
  camp: "Medical camp",
  other: "Other",
};

export const METHODS = { cash: "Cash", upi: "UPI", bank: "Bank transfer", other: "Other" };

export const AGREEMENT_TYPES = {
  fixed: "Fixed salary",
  pct: "Percentage of eligible revenue",
  min: "Minimum guaranteed amount",
  max_min_pct: "Higher of minimum guarantee or percentage",
  min_plus_pct: "Minimum guarantee plus percentage",
  salary_plus_pct: "Fixed salary plus percentage",
  manual: "Manually entered settlement amount",
};

export const REVENUE_BASES = {
  gross: "Gross consultation fees (from my records)",
  net: "Net fees after discounts (from my records)",
  collected: "Fees collected by hospital (hospital-reported)",
  custom: "Other defined base (entered per period)",
};

export const FREQUENCIES = {
  monthly: "Monthly",
  fortnightly: "Fortnightly",
  weekly: "Weekly",
  quarterly: "Quarterly",
};

export const ADJUSTMENT_TYPES = {
  discount: "Discount",
  waiver: "Fee waiver",
  correction: "Fee correction",
  cancellation: "Cancellation",
  settlement: "Settlement adjustment",
};

export function defaultCategories(newFee, followFee) {
  return [
    { key: "new", label: "New patient", feePaise: newFee, isVisit: true },
    { key: "followup", label: "Follow-up", feePaise: followFee, isVisit: true },
  ];
}

// Example starting configuration offered on first run. Every value is editable.
export function exampleLocations() {
  const r = (x) => x * 100;
  return {
    payers: [
      { key: "A", name: "Hospital A" },
      { key: "B", name: "Hospital B" },
    ],
    locations: [
      { name: "Hospital A — ICU", kind: "hospital", payer: "A", arrangement: "hospital", fees: [r(400), r(400)] },
      { name: "Hospital A — Private ward", kind: "hospital", payer: "A", arrangement: "hospital", fees: [r(300), r(300)] },
      { name: "Hospital A — General ward", kind: "hospital", payer: "A", arrangement: "hospital", fees: [r(200), r(200)] },
      { name: "Hospital A — OPD", kind: "hospital", payer: "A", arrangement: "hospital", fees: [r(300), r(150)] },
      { name: "Hospital B — OPD", kind: "hospital", payer: "B", arrangement: "mixed", fees: [r(300), r(150)] },
      { name: "Own clinic", kind: "clinic", arrangement: "direct", fees: [r(400), r(200)] },
      { name: "Village OPD 1", kind: "village", arrangement: "direct", fees: [r(150), r(100)] },
      { name: "Village OPD 2", kind: "village", arrangement: "direct", fees: [r(150), r(100)] },
      { name: "Medical camps", kind: "camp", arrangement: "direct", fees: [0, 0] },
      { name: "Other locations", kind: "other", arrangement: "direct", fees: [r(300), r(150)] },
    ],
  };
}
