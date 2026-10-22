// English labels with optional Hindi. When Hindi is on, L() returns an element with
// the Hindi label under the English one.

const HI = {
  home: "होम",
  add: "जोड़ें",
  sessions: "सत्र",
  money: "पैसा",
  reports: "रिपोर्ट",
  more: "और",
  date: "तारीख",
  location: "स्थान",
  session: "सत्र",
  morning: "सुबह",
  afternoon: "दोपहर",
  evening: "शाम",
  custom: "अन्य",
  newPatients: "नए मरीज़",
  followups: "फ़ॉलो-अप",
  patients: "मरीज़",
  fee: "फ़ीस",
  grossFees: "कुल फ़ीस",
  discounts: "छूट / माफ़ी",
  netFees: "देय फ़ीस",
  cash: "नकद",
  upi: "यूपीआई",
  bank: "बैंक ट्रांसफ़र",
  other: "अन्य",
  unpaid: "बकाया",
  collected: "प्राप्त",
  outstanding: "बकाया राशि",
  remarks: "टिप्पणी",
  save: "सहेजें",
  patientId: "मरीज़ आईडी",
  patientName: "मरीज़ का नाम",
  visitType: "विज़िट प्रकार",
  amountReceived: "प्राप्त राशि",
  paymentMethod: "भुगतान का तरीका",
  hospital: "अस्पताल",
  revenue: "परामर्श आय",
  collections: "वसूली",
  earnings: "मेरी कमाई",
  today: "आज",
  thisMonth: "इस महीने",
  quickSummary: "त्वरित सारांश",
  individualEntry: "हर मरीज़ की एंट्री",
  reference: "संदर्भ",
  reason: "कारण",
};

const EN = {
  home: "Home",
  add: "Add",
  sessions: "Sessions",
  money: "Money",
  reports: "Reports",
  more: "More",
  date: "Date",
  location: "Location",
  session: "Session",
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  custom: "Custom",
  newPatients: "New patients",
  followups: "Follow-ups",
  patients: "Patients",
  fee: "Fee",
  grossFees: "Gross fees",
  discounts: "Discounts & waivers",
  netFees: "Net fees payable",
  cash: "Cash",
  upi: "UPI",
  bank: "Bank transfer",
  other: "Other",
  unpaid: "Unpaid",
  collected: "Collected",
  outstanding: "Outstanding",
  remarks: "Remarks",
  save: "Save",
  patientId: "Patient ID (optional)",
  patientName: "Patient name (optional)",
  visitType: "Visit type",
  amountReceived: "Amount received",
  paymentMethod: "Payment method",
  hospital: "Hospital",
  revenue: "Consultation revenue",
  collections: "Collections",
  earnings: "My earnings",
  today: "Today",
  thisMonth: "This month",
  quickSummary: "Quick session summary",
  individualEntry: "Individual patient entry",
  reference: "Reference",
  reason: "Reason",
};

let hindi = false;
export function setHindi(on) {
  hindi = !!on;
}
export function isHindi() {
  return hindi;
}

export function T(key) {
  return EN[key] || key;
}

// Label for a key, or a literal string when it is not a known key.
export function L(key) {
  const en = EN[key] || key;
  if (!hindi || !HI[key]) return en;
  const s = document.createElement("span");
  s.className = "bi";
  s.append(en, Object.assign(document.createElement("small"), { className: "hi", lang: "hi", textContent: HI[key] }));
  return s;
}
