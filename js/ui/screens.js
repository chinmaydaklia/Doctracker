import { renderHome } from "./home.js";
import { renderAdd, renderSummaryForm, renderVisitForm } from "./entry.js";
import { renderSessions, renderSession } from "./sessions.js";
import { renderMoney, renderHospital, renderSettlement } from "./money.js";
import { renderReports } from "./reportsui.js";
import { renderMore, renderWelcome, renderLocations, renderLocation, renderBackup, renderAudit, renderImportOld } from "./settings.js";

// tab: top-level screen in the bottom navigation; parent: tab highlighted for a sub-screen.
// needsParams: cannot be opened from a bare URL (its parameters live in memory only,
// so no record IDs or patient data ever appear in the address bar).
export const screens = {
  welcome: { render: renderWelcome, parent: "home" },
  home: { render: renderHome, tab: true },
  add: { render: renderAdd, tab: true },
  summary: { render: renderSummaryForm, parent: "add" },
  visit: { render: renderVisitForm, parent: "add" },
  sessions: { render: renderSessions, tab: true },
  session: { render: renderSession, parent: "sessions", needsParams: true },
  money: { render: renderMoney, tab: true },
  hospital: { render: renderHospital, parent: "money", needsParams: true },
  settlement: { render: renderSettlement, parent: "money", needsParams: true },
  reports: { render: renderReports, tab: true },
  more: { render: renderMore, tab: true },
  locations: { render: renderLocations, parent: "more" },
  location: { render: renderLocation, parent: "more" },
  backup: { render: renderBackup, parent: "more" },
  audit: { render: renderAudit, parent: "more" },
  importOld: { render: renderImportOld, parent: "more" },
};
