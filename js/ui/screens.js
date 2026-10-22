import { renderHome } from "./home.js";
import { renderAdd, renderSummaryForm, renderVisitForm } from "./entry.js";
import { renderSessions, renderSession } from "./sessions.js";
import { renderMoney, renderHospital, renderSettlement } from "./money.js";
import { renderReports } from "./reportsui.js";
import { renderMore, renderWelcome, renderLocations, renderLocation, renderBackup, renderAudit, renderImportOld, renderClinicalSettings } from "./settings.js";
import { renderLogin, renderSecuritySetup, renderUsers } from "./security.js";
import { renderPatients, renderPatientForm, renderPatient } from "./patients.js";
import { renderNewEncounter, renderEncounter, renderNote } from "./encounter.js";
import { renderScan, renderScanReview } from "./scan.js";

// tab: top-level screen in the bottom navigation; parent: tab highlighted for a sub-screen.
// needsParams: cannot be opened from a bare URL (its parameters live in memory only,
// so no record IDs or patient data ever appear in the address bar).
// perm: permission the signed-in role needs (checked by the router and again by the store).
export const screens = {
  login: { render: renderLogin },
  welcome: { render: renderWelcome, parent: "home", perm: "finance.admin" },
  home: { render: renderHome, tab: true },
  add: { render: renderAdd, tab: true, perm: "finance" },
  summary: { render: renderSummaryForm, parent: "add", perm: "finance" },
  visit: { render: renderVisitForm, parent: "add", perm: "finance" },
  sessions: { render: renderSessions, tab: true, perm: "finance" },
  session: { render: renderSession, parent: "sessions", needsParams: true, perm: "finance" },
  money: { render: renderMoney, tab: true, perm: "finance" },
  hospital: { render: renderHospital, parent: "money", needsParams: true, perm: "finance.admin" },
  settlement: { render: renderSettlement, parent: "money", needsParams: true, perm: "finance.admin" },
  reports: { render: renderReports, tab: true, perm: "reports" },
  patients: { render: renderPatients, tab: true, perm: "patients" },
  patientForm: { render: renderPatientForm, parent: "patients", perm: "patients" },
  patient: { render: renderPatient, parent: "patients", needsParams: true, perm: "patients" },
  newEncounter: { render: renderNewEncounter, parent: "patients", perm: "clinical.write" },
  encounter: { render: renderEncounter, parent: "patients", needsParams: true, perm: "vitals" },
  note: { render: renderNote, parent: "patients", needsParams: true, perm: "clinical.read" },
  scan: { render: renderScan, parent: "patients", perm: "clinical.write" },
  scanReview: { render: renderScanReview, parent: "patients", needsParams: true, perm: "clinical.read" },
  more: { render: renderMore, tab: true },
  locations: { render: renderLocations, parent: "more", perm: "finance.admin" },
  location: { render: renderLocation, parent: "more", perm: "finance.admin" },
  backup: { render: renderBackup, parent: "more", perm: "backup" },
  audit: { render: renderAudit, parent: "more", perm: "backup" },
  importOld: { render: renderImportOld, parent: "more", perm: "finance.admin" },
  security: { render: renderSecuritySetup, parent: "more" },
  users: { render: renderUsers, parent: "more" },
  clinicalSettings: { render: renderClinicalSettings, parent: "more", perm: "clinical.write" },
};
