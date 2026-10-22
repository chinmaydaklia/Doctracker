// Synthetic reader outputs modelled on typical Indian OPD prescriptions (cursive English,
// Hindi/English mix, brand names, shorthand). They exercise the review/import pipeline;
// real handwriting accuracy is measured separately with scripts/ocr-eval.js on real,
// anonymised images.

const R = (text, confidence = 0.95, legibility = "clear", alternatives = []) => ({ text, legibility, confidence, alternatives });
const NONE = { text: null, legibility: "clear", confidence: 1, alternatives: [] };
const med = (o) => ({ name: NONE, strength: NONE, form: NONE, dose: NONE, route: NONE, frequency: NONE, timing: NONE, duration: NONE, quantity: NONE, instructions: NONE, ...o });

// 1. GP prescription, cursive English, fever with cough; temperature written in °F.
export const feverRx = {
  document: { kind: "handwritten_prescription", image_quality: "fair", quality_issues: ["slight blur at bottom"], languages: ["English"], date: R("12/3/26"), prescriber: R("Dr. A. Sharma, MBBS"), clinic: R("Shree Clinic, Rajnandgaon", 0.9) },
  patient: { name: R("Ramesh Kumar"), age: R("54 y"), sex: R("M"), id_number: NONE, mobile: NONE },
  chief_complaints: [
    { complaint: R("fever"), duration: R("3 days") },
    { complaint: R("cough c expectoration", 0.7, "unclear", ["cough with expectoration"]), duration: R("2 days", 0.9) },
  ],
  comorbidities: [{ condition: R("DM"), written_as: "known_case" }, { condition: R("HTN"), written_as: "known_case" }],
  vitals: [
    { type: "bp", label: R("BP"), value: R("150/90"), unit: R("mmHg") },
    { type: "pulse", label: R("PR"), value: R("96"), unit: R("/min") },
    { type: "temp", label: R("Temp"), value: R("101"), unit: R("°F") },
    { type: "spo2", label: R("SpO2"), value: R("97%"), unit: R("RA", 0.85) },
  ],
  examination: [{ system: "rs", finding: R("B/L air entry equal, no crepts", 0.82), written_status: "normal" }],
  diagnoses: [{ diagnosis: R("? Viral fever", 0.9), written_qualifier: "query" }],
  investigations: [
    { name: R("CBC"), result: NONE, unit: NONE, kind: "advised" },
    { name: R("Dengue NS1", 0.75, "unclear", ["Dengue IgM"]), result: NONE, unit: NONE, kind: "advised" },
  ],
  medications: [
    med({ name: R("Tab Dolo 650"), dose: R("1 tab"), frequency: R("1-0-1"), duration: R("x 3d"), timing: R("after food", 0.9) }),
    med({ name: R("Tab Azithrol 500", 0.6, "unclear", ["Azithral 500"]), frequency: R("OD"), duration: R("3 days") }),
    med({ name: R("Syp Ascoril"), dose: R("2 tsp", 0.9), frequency: R("TDS", 0.65, "unclear", ["BD"]), duration: NONE }),
    med({ name: R("Tab Pan-D"), frequency: R("1-0-0"), timing: R("BBF"), duration: R("5/7") }),
  ],
  advice: [R("Plenty of oral fluids"), R("Tepid sponging if fever >101", 0.85)],
  follow_up: { interval: R("after 3 days"), date: NONE, instructions: R("SOS if breathlessness", 0.8) },
  unparsed_text: [],
  conflicts: [],
};

// 2. Hindi / English mix, chronic disease follow-up; one frequency illegible.
export const hindiRx = {
  document: { kind: "handwritten_prescription", image_quality: "good", quality_issues: [], languages: ["Hindi", "English"], date: R("05-09-2026"), prescriber: NONE, clinic: R("ग्राम ओपीडी, डोंगरगढ़", 0.8) },
  patient: { name: R("रामेश्वर साहू"), age: R("62"), sex: R("पु", 0.7, "unclear", ["M"]), id_number: NONE, mobile: R("98765 43210", 0.9) },
  chief_complaints: [{ complaint: R("चक्कर आना"), duration: R("1 हफ्ता", 0.9) }],
  comorbidities: [{ condition: R("T2DM"), written_as: "known_case" }],
  vitals: [{ type: "bp", label: R("BP"), value: R("160/100"), unit: NONE }, { type: "glucose", label: R("RBS"), value: R("246", 0.85), unit: R("mg/dl") }],
  examination: [],
  diagnoses: [{ diagnosis: R("HTN"), written_qualifier: "known_case" }, { diagnosis: R("Uncontrolled DM", 0.88), written_qualifier: "none" }],
  investigations: [{ name: R("HbA1c"), result: NONE, unit: NONE, kind: "advised" }],
  medications: [
    med({ name: R("Tab Telma 40"), frequency: R("सुबह"), timing: R("खाने के बाद"), duration: R("1 महीने", 0.9) }),
    med({ name: R("Tab Glycomet 500"), frequency: { text: null, legibility: "illegible", confidence: 0, alternatives: [] }, duration: R("continue") }),
  ],
  advice: [R("नमक कम खाएं"), R("रोज़ 30 मिनट टहलें", 0.9)],
  follow_up: { interval: R("1 महीने बाद"), date: NONE, instructions: NONE },
  unparsed_text: ["(stamp, unreadable)"],
  conflicts: [],
};

// 3. A blurred photo: almost nothing legible.
export const unreadableRx = {
  document: { kind: "handwritten_prescription", image_quality: "unreadable", quality_issues: ["motion blur", "glare"], languages: [], date: { text: null, legibility: "illegible", confidence: 0, alternatives: [] }, prescriber: NONE, clinic: NONE },
  patient: { name: { text: null, legibility: "illegible", confidence: 0, alternatives: [] }, age: NONE, sex: NONE, id_number: NONE, mobile: NONE },
  chief_complaints: [],
  comorbidities: [],
  vitals: [],
  examination: [],
  diagnoses: [],
  investigations: [],
  medications: [med({ name: { text: null, legibility: "illegible", confidence: 0, alternatives: [] } })],
  advice: [],
  follow_up: { interval: NONE, date: NONE, instructions: NONE },
  unparsed_text: [],
  conflicts: [],
};

// 4. Conflicting doses written for the same medicine; patient name written differently.
export const conflictRx = {
  ...feverRx,
  patient: { ...feverRx.patient, name: R("Suresh Patel") },
  medications: [med({ name: R("Tab Amlong 5"), dose: R("1 tab"), frequency: R("OD"), duration: R("1 month") }), med({ name: R("Tab Amlong 10", 0.7, "unclear", ["Amlong 5"]), frequency: R("OD"), duration: R("1 month") })],
  conflicts: ["Amlodipine written twice with different strengths (5 mg and 10 mg)"],
};
