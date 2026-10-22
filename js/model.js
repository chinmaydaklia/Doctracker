// Domain constants, store names and example configuration.

export const DB_SCHEMA_VERSION = 2; // IndexedDB object-store layout (1 = financial only, 2 = + clinical)
export const DATA_FORMAT = 2; // backup file format (1 = financial only; still restorable)

export const FINANCIAL_STORES = [
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
];

// Clinical content encrypted at rest. Only the fields in CLINICAL_META (links,
// dates, status) are stored in clear so counts and links work without the key.
export const CLINICAL_META = {
  profiles: ["patientId"],
  conditions: ["patientId"],
  allergies: ["patientId"],
  medications: ["patientId"],
  encounters: ["patientId", "visitId", "sessionId", "locationId", "date", "status", "doctorId", "followUpDate", "type"],
  vitals: ["patientId", "encounterId", "takenAt"],
  diagnoses: ["patientId", "encounterId"],
  investigations: ["patientId", "encounterId"],
  prescriptions: ["patientId", "encounterId", "status"],
  noteVersions: ["patientId", "encounterId", "version", "signedAt"],
  files: ["patientId", "encounterId", "investigationId", "size"],
};
export const CLINICAL_STORES = Object.keys(CLINICAL_META);

export const STORES = [
  ...FINANCIAL_STORES,
  "patients", // demographics (needed by reception), not clinical content
  ...CLINICAL_STORES,
  "blobs", // encrypted attachment bytes, loaded on demand only
  "templates", // reusable complaint/exam/prescription templates and favourites (no patient data)
  "users",
  "clinicalAudit", // who viewed/changed which clinical record; never clinical content
  "snapshots",
];
// Stores that make up "the records" (exported, counted, checksummed).
export const DATA_STORES = STORES.filter((s) => s !== "snapshots");
// Stores not held in memory (fetched on demand).
export const LAZY_STORES = ["blobs", "snapshots"];

export const ROLES = {
  doctor: "Doctor",
  receptionist: "Receptionist",
  staff: "Staff / nurse",
};

// What each role may do. Clinical *reading* additionally needs the data key, which
// receptionists never receive.
export const PERMISSIONS = {
  doctor: ["finance", "finance.admin", "reports", "patients", "clinical.read", "clinical.write", "clinical.sign", "vitals", "investigations", "export", "users", "backup"],
  receptionist: ["finance", "patients"],
  staff: ["patients", "vitals", "investigations"],
};
// Before any account exists the app behaves as the single-user financial tracker.
export const OWNER_PERMISSIONS = ["finance", "finance.admin", "reports", "patients", "users", "backup"];

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

// ------------------------------------------------------------- clinical lists
// Suggestions only: every field also accepts free text.

export const SEXES = { female: "Female", male: "Male", other: "Other", unknown: "Not recorded" };

export const ENCOUNTER_TYPES = {
  opd: "OPD consultation",
  followup: "Follow-up",
  ward: "Ward round",
  icu: "ICU",
  camp: "Camp / village OPD",
  tele: "Teleconsultation",
  other: "Other",
};

export const COMMON_COMPLAINTS = [
  "Fever", "Cough", "Breathlessness", "Chest pain", "Palpitations", "Abdominal pain", "Vomiting", "Loose stools",
  "Constipation", "Headache", "Giddiness", "Weakness", "Fatigue", "Body ache", "Joint pain", "Back pain",
  "Swelling of feet", "Burning micturition", "Decreased urine output", "Loss of appetite", "Weight loss",
  "Sore throat", "Cold / running nose", "Skin rash", "Itching", "Numbness", "Seizure", "Syncope",
  "Altered sensorium", "Blood in sputum", "Blood in stool", "Jaundice", "Sleep disturbance", "Anxiety",
];

export const COMORBIDITIES = [
  "Diabetes mellitus type 2", "Diabetes mellitus type 1", "Hypertension", "Coronary artery disease", "Heart failure",
  "Atrial fibrillation", "Chronic kidney disease", "Chronic liver disease", "COPD", "Asthma", "Hypothyroidism",
  "Hyperthyroidism", "Stroke", "Transient ischaemic attack", "Epilepsy", "Pulmonary tuberculosis",
  "Extrapulmonary tuberculosis", "Rheumatoid arthritis", "Systemic lupus erythematosus", "Other autoimmune disorder",
  "Malignancy", "Dyslipidaemia", "Obesity", "Anaemia", "HIV infection", "Hepatitis B", "Hepatitis C",
  "Parkinson's disease", "Dementia", "Depression", "Osteoarthritis", "Gout", "Benign prostatic hyperplasia",
];

export const CONDITION_CATEGORIES = {
  medical: "Medical history / comorbidity",
  surgical: "Surgical history",
  family: "Family history",
  personal: "Personal history",
  lifestyle: "Lifestyle",
};

export const CONDITION_STATUS = { current: "Current", resolved: "Resolved", uncertain: "Uncertain" };

export const EXAM_SYSTEMS = [
  { key: "general", label: "General examination" },
  { key: "cvs", label: "Cardiovascular system" },
  { key: "rs", label: "Respiratory system" },
  { key: "abdomen", label: "Abdomen" },
  { key: "cns", label: "Central nervous system" },
  { key: "msk", label: "Musculoskeletal system" },
  { key: "skin", label: "Skin and mucosa" },
];

export const EXAM_STATUS = { not_examined: "Not examined", normal: "Normal", abnormal: "Abnormal" };

export const DIAGNOSIS_KINDS = { primary: "Primary", secondary: "Secondary", differential: "Differential", comorbidity: "Relevant comorbidity" };
export const CERTAINTY = { provisional: "Provisional", suspected: "Suspected", confirmed: "Confirmed", ruled_out: "Ruled out" };

export const INVESTIGATION_CATEGORIES = {
  cbc: "CBC / haematology",
  renal: "Renal function",
  liver: "Liver function",
  electrolytes: "Electrolytes",
  glucose: "Glucose / HbA1c",
  thyroid: "Thyroid function",
  lipids: "Lipid profile",
  urine: "Urine examination",
  ecg: "ECG",
  xray: "X-ray",
  usg: "Ultrasound",
  ct: "CT",
  mri: "MRI",
  echo: "Echocardiography",
  micro: "Microbiology / serology",
  other: "Other",
};

export const COMMON_INVESTIGATIONS = [
  ["Haemoglobin", "cbc", "g/dL"], ["Total leucocyte count", "cbc", "/µL"], ["Platelet count", "cbc", "/µL"],
  ["Serum creatinine", "renal", "mg/dL"], ["Blood urea", "renal", "mg/dL"], ["eGFR", "renal", "mL/min/1.73m²"],
  ["SGPT (ALT)", "liver", "U/L"], ["SGOT (AST)", "liver", "U/L"], ["Total bilirubin", "liver", "mg/dL"], ["Albumin", "liver", "g/dL"],
  ["Sodium", "electrolytes", "mmol/L"], ["Potassium", "electrolytes", "mmol/L"],
  ["Fasting blood glucose", "glucose", "mg/dL"], ["Post-prandial blood glucose", "glucose", "mg/dL"], ["Random blood glucose", "glucose", "mg/dL"], ["HbA1c", "glucose", "%"],
  ["TSH", "thyroid", "µIU/mL"], ["Free T4", "thyroid", "ng/dL"],
  ["Total cholesterol", "lipids", "mg/dL"], ["LDL cholesterol", "lipids", "mg/dL"], ["Triglycerides", "lipids", "mg/dL"],
  ["Urine routine & microscopy", "urine", ""], ["Urine albumin/creatinine ratio", "urine", "mg/g"],
  ["ECG", "ecg", ""], ["Chest X-ray", "xray", ""], ["USG abdomen", "usg", ""], ["CT brain", "ct", ""], ["MRI brain", "mri", ""], ["2D Echo", "echo", ""],
];

export const ROUTES = ["Oral", "IV", "IM", "SC", "Inhaled", "Nebulised", "Topical", "Sublingual", "Rectal", "Per vaginal", "Eye drops", "Ear drops", "Nasal"];
export const FREQUENCIES_RX = ["OD (once daily)", "BD (twice daily)", "TDS (three times daily)", "QID (four times daily)", "HS (at bedtime)", "SOS (as needed)", "STAT (once now)", "Once weekly", "Alternate days"];
export const TIMINGS = ["Before food", "After food", "With food", "Empty stomach", "Morning", "Night"];

export const GLUCOSE_CONTEXT = { fasting: "Fasting", pp: "Post-prandial (2 h)", random: "Random", premeal: "Pre-meal" };
export const GLUCOSE_SOURCE = { capillary: "Capillary (glucometer)", lab: "Laboratory" };

export const ALLOWED_UPLOADS = { "application/pdf": "PDF", "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
