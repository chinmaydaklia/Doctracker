// Patients: search, registration (with duplicate warnings), profile and longitudinal timeline.
import { h, add, clear, money, date, field, dateInput, segmented, select, toast, modal, confirmDialog, askReason, attempt, badge } from "./dom.js";
import { today, fmtDateTime } from "../dates.js";
import { SEXES, ALLOWED_UPLOADS, CONDITION_CATEGORIES, CONDITION_STATUS, COMORBIDITIES, ENCOUNTER_TYPES, CERTAINTY, DIAGNOSIS_KINDS, INVESTIGATION_CATEGORIES } from "../model.js";
import { ageLabel, searchPatients, problemList, formatVital, vitalLabel, VITAL_DEFS, medicationNeedsVerification, courseEnd } from "../clinical.js";

export const patientLine = (p) => `${p.name} · ${ageLabel(p)} · ${SEXES[p.sex] || ""}`;

function datalist(id, items) {
  return h("datalist", { id }, items.map((x) => h("option", { value: x })));
}

export function renderPatients(app, params) {
  const store = app.store;
  const q = h("input", { type: "search", placeholder: "Name, mobile, patient ID or OPD no.", value: params.q || "", autocomplete: "off" });
  const list = h("div");
  const byPatient = new Map();
  for (const v of store.data.visits) if (v.patientRecordId) (byPatient.get(v.patientRecordId) || byPatient.set(v.patientRecordId, []).get(v.patientRecordId)).push(v);
  const lastSeen = new Map();
  for (const e of store.data.encounters) if (e.status !== "cancelled" && (!lastSeen.get(e.patientId) || e.date > lastSeen.get(e.patientId))) lastSeen.set(e.patientId, e.date);
  const draw = () => {
    clear(list);
    const res = searchPatients(store.data.patients.filter((p) => p.active !== false), q.value, byPatient)
      .sort((a, b) => (lastSeen.get(b.id) || b.registeredAt || "").localeCompare(lastSeen.get(a.id) || a.registeredAt || ""))
      .slice(0, 60);
    if (!res.length) add(list, h("p", { class: "muted" }, q.value ? "No matching patient. Register them below." : "No patients registered yet."));
    for (const p of res)
      add(list, h("button", { class: "row click", onclick: () => app.go("patient", { id: p.id }) }, h("div", null, h("b", null, p.name), h("div", { class: "muted small" }, ageLabel(p), " · ", SEXES[p.sex], " · ", p.id, p.mobile ? " · ☎ " + p.mobile : "")), h("div", { class: "right small muted" }, lastSeen.get(p.id) ? "Seen " + date(lastSeen.get(p.id)) : "Registered " + date(p.registeredAt))));
  };
  q.addEventListener("input", draw);
  draw();
  const due = store.clinicalMetrics(today()).due;
  return h(
    "div",
    { class: "screen" },
    h("h1", null, "Patients"),
    h("div", { class: "card" }, q, h("div", { class: "row-btns" }, h("button", { class: "btn primary", onclick: () => app.go("patientForm", { name: q.value }) }, "+ Register patient"))),
    due.length
      ? h("details", { class: "card" }, h("summary", null, h("b", null, `Follow-ups due within 7 days (${due.length})`)), due.map((e) => {
          const p = store.get("patients", e.patientId);
          return p ? h("button", { class: "row click", onclick: () => app.go("patient", { id: p.id }) }, h("div", null, h("b", null, p.name), h("div", { class: "small muted" }, p.mobile || "")), h("div", { class: "right small" }, date(e.followUpDate), e.followUpDate < today() ? badge("overdue", "bad") : null)) : null;
        }))
      : null,
    list,
  );
}

// --------------------------------------------------------------- registration

export function renderPatientForm(app, params) {
  const store = app.store;
  const p = params.id ? store.get("patients", params.id) : null;
  const st = { sex: p ? p.sex : "unknown", ageMode: p && p.dob ? "dob" : "age" };
  const name = h("input", { type: "text", value: p ? p.name : params.name || "", autocomplete: "off" });
  const nameHi = h("input", { type: "text", lang: "hi", value: p ? p.nameHi : "", placeholder: "optional" });
  const age = h("input", { type: "number", min: 0, max: 130, inputmode: "numeric", value: p && p.ageYears !== null && p.ageYears !== undefined ? p.ageYears : "" });
  const dob = dateInput(p && p.dob ? p.dob : "");
  const ageBox = h("div");
  const drawAge = () => {
    clear(ageBox);
    add(ageBox, st.ageMode === "age" ? field("Age (years)", age) : field("Date of birth", dob));
  };
  drawAge();
  const mobile = h("input", { type: "tel", inputmode: "tel", value: p ? p.mobile : "", placeholder: "optional" });
  const address = h("textarea", { rows: 2, value: p ? p.address : "", placeholder: "optional" });
  const ecName = h("input", { type: "text", value: p ? p.emergencyContact?.name : "" });
  const ecRel = h("input", { type: "text", value: p ? p.emergencyContact?.relation : "" });
  const ecPhone = h("input", { type: "tel", value: p ? p.emergencyContact?.phone : "" });
  const extId = h("input", { type: "text", value: p ? p.externalIds?.[0]?.value || "" : "", placeholder: "UHID / OPD no. (optional)" });
  const err = h("div", { class: "err" });
  const input = () => ({
    name: name.value,
    nameHi: nameHi.value,
    sex: st.sex,
    dob: st.ageMode === "dob" ? dob.value || null : null,
    ageYears: st.ageMode === "age" ? age.value : null,
    mobile: mobile.value,
    address: address.value,
    emergencyContact: { name: ecName.value, relation: ecRel.value, phone: ecPhone.value },
    externalIds: extId.value ? [{ label: "UHID / OPD no.", value: extId.value }] : [],
  });
  const save = async () => {
    err.textContent = "";
    try {
      if (p) {
        await store.updatePatient(p.id, input());
        toast("Saved ✓");
        return app.go("patient", { id: p.id }, { replace: true });
      }
      let r = await store.registerPatient(input());
      if (r.needsConfirm) {
        const choice = await modal(
          "Possible existing patient",
          [h("p", null, "These existing profiles look similar. Open one of them, or register a new, separate patient. Profiles are never merged automatically."), r.matches.map((m) => h("button", { class: "row click", onclick: () => { document.querySelector(".modal-back")?.remove(); app.go("patient", { id: m.patient.id }); } }, h("div", null, h("b", null, m.patient.name), h("div", { class: "small muted" }, ageLabel(m.patient), " · ", m.patient.id, m.patient.mobile ? " · ☎ " + m.patient.mobile : "")), h("div", { class: "right small" }, m.reasons.join(", "))))],
          [{ label: "Cancel", result: false }, { label: "Register as new patient", kind: "primary", result: true }],
        );
        if (!choice) return;
        r = await store.registerPatient(input(), { confirmNew: true });
      }
      toast("Patient registered ✓ " + r.patient.id);
      app.go(params.then === "back" ? "patient" : "patient", { id: r.patient.id }, { replace: true });
    } catch (e) {
      err.textContent = e.message;
    }
  };
  return h(
    "div",
    { class: "screen" },
    h("h1", null, p ? "Edit patient" : "Register patient"),
    h("p", { class: "small muted" }, "Only the name is required. Add what is useful; nothing else is mandatory."),
    h(
      "div",
      { class: "card" },
      field("Name", name),
      field("Name in Hindi", nameHi),
      field("Sex", segmented(Object.entries(SEXES).map(([value, label]) => ({ value, label })), st.sex, (v) => (st.sex = v))),
      field("Age", segmented([{ value: "age", label: "Age in years" }, { value: "dob", label: "Date of birth" }], st.ageMode, (v) => { st.ageMode = v; drawAge(); })),
      ageBox,
      field("Mobile", mobile),
      field("Address", address),
      h("h3", null, "Emergency contact (optional)"),
      h("div", { class: "grid2" }, field("Name", ecName), field("Relation", ecRel)),
      field("Phone", ecPhone),
      field("Hospital / clinic ID", extId),
      err,
      h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => app.back() }, "Cancel"), h("button", { class: "btn primary big", onclick: save }, p ? "Save" : "Register")),
    ),
  );
}

// -------------------------------------------------------------------- profile

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "timeline", label: "Timeline" },
  { value: "vitals", label: "Vitals" },
  { value: "reports", label: "Reports" },
  { value: "medicines", label: "Medicines" },
  { value: "visits", label: "Visits & fees" },
];

export function renderPatient(app, params) {
  const store = app.store;
  const p = store.get("patients", params.id);
  if (!p) return h("div", { class: "screen" }, "Patient not found.");
  const clinical = store.can("clinical.read");
  const tabs = TABS.filter((t) => (t.value === "visits" ? store.perms.includes("finance") : t.value === "overview" || clinical));
  const tab = tabs.some((t) => t.value === params.tab) ? params.tab : "overview";
  const rec = clinical ? store.patientRecord(p.id) : null;
  const goTab = (v) => app.go("patient", { id: p.id, tab: v }, { replace: true });

  const activeAllergies = rec ? rec.allergies.filter((a) => a.status === "active") : [];
  const header = h(
    "div",
    { class: "card patient-head" },
    h("h1", null, p.name, p.nameHi ? h("small", { lang: "hi" }, " · " + p.nameHi) : null),
    h("div", null, ageLabel(p), " · ", SEXES[p.sex], " · ", h("b", null, p.id), p.mobile ? " · ☎ " + p.mobile : ""),
    rec
      ? h(
          "div",
          { class: "badges" },
          activeAllergies.length ? activeAllergies.map((a) => badge("⚠ Allergy: " + a.substance, "bad")) : rec.profile?.nkda ? badge("No known drug allergies", "ok") : badge("Allergy status not recorded", "warn"),
          rec.profile?.alerts ? badge("⚑ " + rec.profile.alerts, "bad") : null,
        )
      : h("p", { class: "small muted" }, store.perms.includes("clinical.read") ? "Sign in with a doctor account to see clinical records." : "Clinical records are visible to the treating doctor only."),
    h(
      "div",
      { class: "row-btns wrap" },
      store.can("clinical.write") ? h("button", { class: "btn primary", onclick: () => app.go("newEncounter", { patientId: p.id }) }, "+ New consultation") : null,
      store.perms.includes("finance") ? h("button", { class: "btn", onclick: () => app.go("visit", { patientRecordId: p.id }) }, "+ Visit / fee only") : null,
      h("button", { class: "btn small", onclick: () => app.go("patientForm", { id: p.id }) }, "Edit details"),
    ),
  );

  let body;
  if (tab === "overview") body = overview(app, p, rec);
  else if (tab === "timeline") body = timeline(app, p, rec, params);
  else if (tab === "vitals") body = vitalsTab(rec);
  else if (tab === "reports") body = reportsTab(app, p, rec);
  else if (tab === "medicines") body = medicinesTab(app, p, rec);
  else body = visitsTab(app, p);

  return h("div", { class: "screen" }, header, tabs.length > 1 ? segmented(tabs, tab, goTab, { cls: "tabs" }) : null, body);
}

function overview(app, p, rec) {
  const store = app.store;
  const demo = h(
    "div",
    { class: "card" },
    h("h3", null, "Details"),
    h("div", { class: "kv" }, h("span", null, "Registered"), h("b", null, date(p.registeredAt))),
    p.dob ? h("div", { class: "kv" }, h("span", null, "Date of birth"), h("b", null, date(p.dob))) : null,
    p.address ? h("div", { class: "kv" }, h("span", null, "Address"), h("b", null, p.address)) : null,
    p.emergencyContact?.name || p.emergencyContact?.phone ? h("div", { class: "kv" }, h("span", null, "Emergency contact"), h("b", null, [p.emergencyContact.name, p.emergencyContact.relation, p.emergencyContact.phone].filter(Boolean).join(" · "))) : null,
    (p.externalIds || []).map((x) => h("div", { class: "kv" }, h("span", null, x.label), h("b", null, x.value))),
  );
  if (!rec) return demo;
  const canEdit = store.can("clinical.write");
  const probs = problemList(rec.diagnoses);
  const rerender = () => app.render();
  const cond = (cat) => rec.conditions.filter((c) => c.category === cat && c.status !== "entered_in_error");
  return h(
    "div",
    null,
    h(
      "div",
      { class: "card" },
      h("h3", null, "Alerts & clinical notes"),
      rec.profile?.alerts ? h("p", { class: "badc" }, rec.profile.alerts) : h("p", { class: "muted small" }, "No alerts."),
      rec.profile?.notes ? h("p", null, rec.profile.notes) : null,
      canEdit ? h("button", { class: "btn small", onclick: () => profileDialog(app, p, rec.profile).then((ok) => ok && rerender()) }, "Edit") : null,
    ),
    h(
      "div",
      { class: "card" },
      h("h3", null, "Drug allergies"),
      rec.allergies.filter((a) => a.status !== "entered_in_error").length
        ? rec.allergies.filter((a) => a.status !== "entered_in_error").map((a) => h("div", { class: "row" + (a.status === "inactive" ? " dim" : "") }, h("div", { class: "grow" }, h("b", null, a.substance), " ", a.reaction ? "→ " + a.reaction : "", a.severity ? ` (${a.severity})` : "", h("div", { class: "small muted" }, a.status === "inactive" ? "inactive · " : "", "noted ", date(a.notedAt))), canEdit ? h("button", { class: "link small", onclick: () => allergyDialog(app, p, a).then((ok) => ok && rerender()) }, "edit") : null))
        : h("p", { class: "small " + (rec.profile?.nkda ? "okc" : "muted") }, rec.profile?.nkda ? "No known drug allergies (recorded)." : "Not recorded yet — unknown is not the same as none."),
      canEdit ? h("div", { class: "row-btns wrap" }, h("button", { class: "btn small", onclick: () => allergyDialog(app, p).then((ok) => ok && rerender()) }, "+ Add allergy"), !rec.allergies.some((a) => a.status === "active") && !rec.profile?.nkda ? h("button", { class: "btn small", onclick: () => attempt(() => store.saveProfile(p.id, { nkda: true })).then(rerender) }, "Record: no known drug allergies") : null) : null,
    ),
    h(
      "div",
      { class: "card" },
      h("h3", null, "Active problems (from diagnoses)"),
      probs.length ? probs.map((d) => h("div", { class: "kv" }, h("span", null, d.name, d.severity ? " — " + d.severity : ""), h("b", null, CERTAINTY[d.certainty], h("small", { class: "muted" }, " · " + date(store.get("encounters", d.encounterId)?.date))))) : h("p", { class: "small muted" }, "None recorded."),
      h("p", { class: "small muted" }, "Each entry is the latest review of that diagnosis. Earlier records stay in the timeline."),
    ),
    Object.entries(CONDITION_CATEGORIES).map(([cat, label]) =>
      h(
        "div",
        { class: "card" },
        h("h3", null, label),
        cond(cat).length ? cond(cat).map((c) => h("div", { class: "row" + (c.status === "resolved" ? " dim" : "") }, h("div", { class: "grow" }, h("b", null, c.name), " ", badge(CONDITION_STATUS[c.status] || c.status, c.status === "current" ? "warn" : "mid"), h("div", { class: "small muted" }, [c.onset && "since " + c.onset, c.complications && "complications: " + c.complications, c.treatment && "treatment: " + c.treatment, c.notes].filter(Boolean).join(" · "))), canEdit ? h("button", { class: "link small", onclick: () => conditionDialog(app, p, cat, c).then((ok) => ok && rerender()) }, "edit") : null)) : h("p", { class: "small muted" }, "Nothing recorded."),
        canEdit ? h("button", { class: "btn small", onclick: () => conditionDialog(app, p, cat).then((ok) => ok && rerender()) }, "+ Add") : null,
      ),
    ),
    demo,
  );
}

function profileDialog(app, p, prof) {
  const alerts = h("input", { type: "text", value: prof?.alerts || "", placeholder: "e.g. On anticoagulant; hearing impaired" });
  const notes = h("textarea", { rows: 3, value: prof?.notes || "" });
  const err = h("div", { class: "err" });
  return modal("Alerts & clinical notes", [field("Alert (shown at the top of every record)", alerts), field("Clinical notes", notes), err], [
    { label: "Cancel", result: false },
    { label: "Save", kind: "primary", value: () => app.store.saveProfile(p.id, { alerts: alerts.value, notes: notes.value }).then(() => true).catch((e) => { err.textContent = e.message; return undefined; }) },
  ]);
}

function allergyDialog(app, p, a) {
  const st = { status: a ? a.status : "active" };
  const sub = h("input", { type: "text", value: a?.substance || "", placeholder: "e.g. Penicillin, Sulfa drugs, NSAIDs" });
  const rx = h("input", { type: "text", value: a?.reaction || "", placeholder: "Reaction, e.g. rash, anaphylaxis" });
  const sev = h("input", { type: "text", value: a?.severity || "", placeholder: "mild / moderate / severe" });
  const notes = h("input", { type: "text", value: a?.notes || "" });
  const err = h("div", { class: "err" });
  return modal(a ? "Edit allergy" : "Add drug allergy", [field("Drug / substance", sub), field("Reaction", rx), field("Severity", sev), field("Notes", notes), a ? field("Status", segmented([{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }, { value: "entered_in_error", label: "Entered in error" }], st.status, (v) => (st.status = v))) : null, err], [
    { label: "Cancel", result: false },
    { label: "Save", kind: "primary", value: () => app.store.saveAllergy({ id: a?.id, patientId: p.id, substance: sub.value, reaction: rx.value, severity: sev.value, notes: notes.value, status: st.status }).then(() => true).catch((e) => { err.textContent = e.message; return undefined; }) },
  ]);
}

function conditionDialog(app, p, category, c) {
  const st = { status: c ? c.status : "current" };
  const name = h("input", { type: "text", value: c?.name || "", list: "dl-comorb", autocomplete: "off", placeholder: category === "medical" ? "Search or type, e.g. Hypertension" : "" });
  const onset = h("input", { type: "text", value: c?.onset || "", placeholder: "e.g. 2018, 5 years ago" });
  const comp = h("input", { type: "text", value: c?.complications || "" });
  const tx = h("input", { type: "text", value: c?.treatment || "" });
  const notes = h("input", { type: "text", value: c?.notes || "" });
  const err = h("div", { class: "err" });
  return modal(CONDITION_CATEGORIES[category], [datalist("dl-comorb", COMORBIDITIES), field("Condition / item", name), field("Onset or diagnosis date (approx.)", onset), field("Status", segmented([...Object.entries(CONDITION_STATUS).map(([value, label]) => ({ value, label })), ...(c ? [{ value: "entered_in_error", label: "Entered in error" }] : [])], st.status, (v) => (st.status = v))), field("Complications", comp), field("Current treatment", tx), field("Notes", notes), err], [
    { label: "Cancel", result: false },
    { label: "Save", kind: "primary", value: () => app.store.saveCondition({ id: c?.id, patientId: p.id, category, name: name.value, onset: onset.value, status: st.status, complications: comp.value, treatment: tx.value, notes: notes.value }).then(() => true).catch((e) => { err.textContent = e.message; return undefined; }) },
  ]);
}

// ----------------------------------------------------------------- timeline

function timeline(app, p, rec, params) {
  const store = app.store;
  const f = { from: params.from || "", to: params.to || "", loc: params.loc || "", dx: params.dx || "", type: params.type || "" };
  const out = h("div");
  const draw = () => {
    clear(out);
    const items = [];
    for (const e of rec.encounters) {
      if (f.from && e.date < f.from) continue;
      if (f.to && e.date > f.to) continue;
      if (f.loc && e.locationId !== f.loc) continue;
      if (f.type && e.type !== f.type) continue;
      const dxs = rec.diagnoses.filter((d) => d.encounterId === e.id && !d.voided);
      if (f.dx && !dxs.some((d) => d.name.toLowerCase().includes(f.dx.toLowerCase()))) continue;
      items.push({ date: e.date, sort: e.date + (e.time || ""), node: encounterCard(app, e, rec, dxs) });
    }
    for (const i of rec.investigations.filter((i) => !i.encounterId)) {
      const d = i.resultAt || i.performedAt || i.orderedAt || "";
      if ((f.from && d < f.from) || (f.to && d > f.to) || f.loc || f.dx || f.type) continue;
      items.push({ date: d, sort: d, node: h("div", { class: "card tl" }, h("div", { class: "small muted" }, date(d), " · Report"), h("b", null, i.name), " ", i.value ? `${i.value} ${i.unit}` : "") });
    }
    items.sort((a, b) => (a.sort < b.sort ? 1 : -1));
    add(out, items.length ? items.map((x) => x.node) : h("p", { class: "muted" }, "Nothing matches."));
  };
  const locs = [...new Set(rec.encounters.map((e) => e.locationId))];
  const dxIn = h("input", { type: "search", placeholder: "Diagnosis contains…", value: f.dx, oninput: (e) => { f.dx = e.target.value; draw(); } });
  draw();
  return h(
    "div",
    null,
    h(
      "details",
      { class: "card filters" },
      h("summary", null, "Filter"),
      h("div", { class: "grid2" }, field("From", dateInput(f.from, (v) => { f.from = v; draw(); })), field("To", dateInput(f.to, (v) => { f.to = v; draw(); }))),
      h("div", { class: "grid2" }, field("location", select([{ value: "", label: "All locations" }, ...locs.map((id) => ({ value: id, label: store.locationName(id) }))], f.loc, (v) => { f.loc = v; draw(); })), field("Encounter type", select([{ value: "", label: "All types" }, ...Object.entries(ENCOUNTER_TYPES).map(([value, label]) => ({ value, label }))], f.type, (v) => { f.type = v; draw(); }))),
      field("Diagnosis", dxIn),
    ),
    out,
  );
}

function encounterCard(app, e, rec, dxs) {
  const store = app.store;
  const vit = rec.vitals.filter((v) => v.encounterId === e.id && !v.voided);
  const rx = rec.prescriptions.filter((r) => r.encounterId === e.id && r.status === "approved");
  const stBadge = { draft: ["Draft", "warn"], amending: ["Amending", "warn"], finalized: ["Signed" + (e.version > 1 ? ` v${e.version}` : ""), "ok"], cancelled: ["Cancelled", "mid"] }[e.status];
  return h(
    "button",
    { class: "card tl click", onclick: () => app.go("encounter", { id: e.id }) },
    h("div", { class: "small muted" }, date(e.date), e.time ? " " + e.time : "", " · ", store.locationName(e.locationId), " · ", ENCOUNTER_TYPES[e.type], " · ", e.doctorName || "", " ", badge(stBadge[0], stBadge[1])),
    (e.complaints || []).length ? h("div", null, h("b", null, "C/o: "), e.complaints.map((c) => c.text + (c.duration ? " × " + c.duration : "")).join(", ")) : null,
    dxs.length ? h("div", null, h("b", null, "Dx: "), dxs.map((d) => `${d.name} (${CERTAINTY[d.certainty].toLowerCase()})`).join("; ")) : null,
    vit.length ? h("div", { class: "small" }, vit.slice(0, 6).map((v) => `${vitalLabel(v)} ${formatVital(v)}`).join(" · ")) : null,
    rx.length ? h("div", { class: "small" }, h("b", null, "Rx: "), rx.flatMap((r) => r.items.map((i) => [i.drug, i.strength, i.frequency].filter(Boolean).join(" "))).join("; ")) : null,
    e.followUp?.date || e.followUp?.interval ? h("div", { class: "small" }, "Follow-up: ", e.followUp.interval || "", e.followUp.date ? " · " + date(e.followUp.date) : "") : null,
    e.status === "cancelled" ? h("div", { class: "small muted" }, "Cancelled: ", e.cancelReason) : null,
  );
}

// ------------------------------------------------------------------- vitals

// Single-series sparkline: one hue (brand), 2px line, last point marked; each point
// has a native tooltip. The table beside it is the accessible / exact view.
function sparkline(points, label, { second } = {}) {
  const W = 220, H = 56, P = 6;
  const all = [...points, ...(second || [])].map((p) => p.v);
  if (points.length < 2) return null;
  const min = Math.min(...all), max = Math.max(...all);
  const x = (i, n) => P + (i * (W - 2 * P)) / Math.max(1, n - 1);
  const y = (v) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(i, pts.length).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${label} trend, ${points.length} readings from ${points[0].v} to ${points[points.length - 1].v}`);
  const mk = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  for (const [pts, dashed] of [[points, false], ...(second ? [[second, true]] : [])]) {
    svg.append(mk("path", { d: path(pts), class: "spark-line" + (dashed ? " dashed" : "") }));
    pts.forEach((p, i) => {
      const c = mk("circle", { cx: x(i, pts.length), cy: y(p.v), r: i === pts.length - 1 ? 4 : 8, class: i === pts.length - 1 ? "spark-dot" : "spark-hit" });
      const t = mk("title", {});
      t.textContent = `${p.label}: ${p.v}`;
      c.append(t);
      svg.append(c);
    });
  }
  return svg;
}

function vitalsTab(rec) {
  const live = rec.vitals.filter((v) => !v.voided).sort((a, b) => (a.takenAt < b.takenAt ? -1 : 1));
  if (!live.length) return h("p", { class: "muted" }, "No vitals recorded yet.");
  const types = Object.keys(VITAL_DEFS).filter((t) => live.some((v) => v.type === t));
  return h(
    "div",
    null,
    types.map((t) => {
      const rows = live.filter((v) => v.type === t);
      const pts = rows.filter((v) => typeof v.value === "number").map((v) => ({ v: v.value, label: fmtDateTime(v.takenAt) }));
      const chart = t === "bp" ? sparkline(rows.map((v) => ({ v: v.values.systolic, label: fmtDateTime(v.takenAt) + " systolic" })), "Systolic BP", { second: rows.map((v) => ({ v: v.values.diastolic, label: fmtDateTime(v.takenAt) + " diastolic" })) }) : sparkline(pts, VITAL_DEFS[t].label);
      const last = rows[rows.length - 1];
      const prev = rows[rows.length - 2];
      return h(
        "div",
        { class: "card" },
        h("h3", null, VITAL_DEFS[t].label, h("small", { class: "muted" }, ` · latest ${formatVital(last)} (${fmtDateTime(last.takenAt)})${prev ? ` · previous ${formatVital(prev)}` : ""}`)),
        chart ? h("div", { class: "spark-wrap" }, chart, t === "bp" ? h("div", { class: "small muted" }, "— systolic   - - diastolic") : null) : null,
        h("div", { class: "table-wrap" }, h("table", { class: "tbl" }, h("tbody", null, [...rows].reverse().map((v) => h("tr", null, h("td", null, fmtDateTime(v.takenAt)), h("td", { class: "num" }, formatVital(v)), h("td", { class: "small" }, (v.flags || []).join("; "))))))),
      );
    }),
    h("p", { class: "small muted" }, "Flags compare with adult reference ranges where the patient is 18 or older. A flag is a prompt to review, not a diagnosis."),
  );
}

// ------------------------------------------------------------------ reports

function reportsTab(app, p, rec) {
  const store = app.store;
  const byName = new Map();
  for (const i of rec.investigations) (byName.get(i.name) || byName.set(i.name, []).get(i.name)).push(i);
  const canAdd = store.can("investigations") || store.perms.includes("investigations");
  return h(
    "div",
    null,
    canAdd ? h("button", { class: "btn primary small", onclick: () => import("./encounter.js").then((m) => m.investigationDialog(app, p.id, null).then((ok) => ok && app.render())) }, "+ Add report / result") : null,
    byName.size === 0 ? h("p", { class: "muted" }, "No investigations recorded yet.") : null,
    [...byName.entries()].map(([name, list]) => {
      list.sort((a, b) => ((a.resultAt || a.orderedAt || "") < (b.resultAt || b.orderedAt || "") ? 1 : -1));
      const numeric = list.filter((i) => i.value && !isNaN(Number(i.value))).reverse();
      return h(
        "div",
        { class: "card" },
        h("h3", null, name, h("small", { class: "muted" }, " · " + INVESTIGATION_CATEGORIES[list[0].category])),
        numeric.length > 1 ? h("div", { class: "spark-wrap" }, sparkline(numeric.map((i) => ({ v: Number(i.value), label: date(i.resultAt) })), name)) : null,
        h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "tbl" },
            h("thead", null, h("tr", null, h("th", null, "Result date"), h("th", { class: "num" }, "Value"), h("th", null, "Ref"), h("th", null, "Notes"), h("th", null, "Files"))),
            h(
              "tbody",
              null,
              list.map((i) => {
                const files = rec.files.filter((f) => f.investigationId === i.id);
                return h("tr", null, h("td", null, date(i.resultAt || i.performedAt || i.orderedAt), i.status === "ordered" ? " (ordered)" : ""), h("td", { class: "num" }, i.value ? `${i.value} ${i.unit}` : "—"), h("td", null, i.refRange || ""), h("td", { class: "small" }, i.interpretation || ""), h("td", null, files.map((f) => fileLink(app, f))));
              }),
            ),
          ),
        ),
      );
    }),
    rec.files.filter((f) => !f.investigationId).length ? h("div", { class: "card" }, h("h3", null, "Other attachments"), rec.files.filter((f) => !f.investigationId).map((f) => h("div", null, fileLink(app, f), " ", h("small", { class: "muted" }, date(new Date(f.createdAt).toISOString().slice(0, 10)))))) : null,
  );
}

export function fileLink(app, f) {
  return h("button", { class: "link small", onclick: () => openFile(app, f.id) }, "📎 " + (f.name || "file") + ` (${ALLOWED_UPLOADS[f.mime] || "file"}, ${Math.max(1, Math.round(f.size / 1024))} KB)`);
}

export async function openFile(app, id) {
  const f = await attempt(() => app.store.readFile(id));
  if (!f) return;
  const url = URL.createObjectURL(new Blob([f.bytes], { type: f.mime }));
  const body = f.mime.startsWith("image/") ? h("img", { src: url, alt: f.name, class: "preview" }) : h("p", null, "PDF report: ", f.name);
  await modal(f.name, [body, h("p", { class: "small muted" }, "Uploaded by ", f.uploadedBy, " · ", fmtDateTime(f.createdAt), " · SHA-256 ", f.sha256.slice(0, 12), "…")], [
    { label: "Close", result: true },
    { label: f.mime === "application/pdf" ? "Open PDF" : "Open full size", kind: "primary", value: () => { window.open(url, "_blank", "noopener"); return true; } },
  ]);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------- medicines

function medicinesTab(app, p, rec) {
  const store = app.store;
  const t = today();
  const canEdit = store.can("clinical.write");
  const meds = rec.medications.filter((m) => m.status !== "entered_in_error");
  const rx = rec.prescriptions.filter((r) => r.status === "approved" || r.status === "superseded").sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1));
  return h(
    "div",
    null,
    h(
      "div",
      { class: "card" },
      h("h3", null, "Medicines the patient reports taking"),
      h("p", { class: "small muted" }, "Reported by the patient or family — not prescriptions from this app. Verify at each visit."),
      meds.length
        ? meds.map((m) =>
            h(
              "div",
              { class: "row" + (m.status === "stopped" ? " dim" : "") },
              h("div", { class: "grow" }, h("b", null, m.name), " ", [m.strength, m.dose, m.frequency].filter(Boolean).join(" "), " ", badge(m.status === "taking" ? "taking" : m.status, m.status === "taking" ? "mid" : ""), m.status === "taking" && medicationNeedsVerification(m, t) ? badge(m.lastVerifiedAt ? "verify — last checked " + date(m.lastVerifiedAt) : "not verified", "warn") : null),
              canEdit ? h("div", { class: "right" }, h("button", { class: "link small", onclick: () => attempt(() => store.saveMedication({ ...m, verified: true })).then(() => app.render()) }, "verified today"), h("button", { class: "link small", onclick: () => medicationDialog(app, p, m).then((ok) => ok && app.render()) }, "edit")) : null,
            ),
          )
        : h("p", { class: "small muted" }, "None recorded."),
      canEdit ? h("button", { class: "btn small", onclick: () => medicationDialog(app, p).then((ok) => ok && app.render()) }, "+ Add reported medicine") : null,
    ),
    h(
      "div",
      { class: "card" },
      h("h3", null, "Prescriptions from consultations"),
      rx.length
        ? rx.map((r) => {
            const enc = store.get("encounters", r.encounterId);
            return h("div", { class: "row" + (r.status === "superseded" ? " dim" : "") }, h("div", { class: "grow" }, h("div", { class: "small muted" }, date(enc?.date), " · ", store.locationName(enc?.locationId), r.status === "superseded" ? " · superseded by a later version" : "", r.version > 1 ? ` · version ${r.version}` : ""), r.items.map((i) => {
              const end = courseEnd(i, enc?.date || t);
              return h("div", null, h("b", null, i.drug), " ", [i.strength, i.dose, i.route, i.frequency, i.timing, i.duration && "× " + i.duration].filter(Boolean).join(" "), end ? h("small", { class: end < t ? "muted" : "okc" }, end < t ? ` · course ended ${date(end)}` : ` · course till ${date(end)}`) : null);
            })), h("button", { class: "link small", onclick: () => app.go("encounter", { id: r.encounterId }) }, "open"));
          })
        : h("p", { class: "small muted" }, "None yet."),
      h("p", { class: "small muted" }, "A past prescription is not proof the patient is still taking it."),
    ),
  );
}

function medicationDialog(app, p, m) {
  const st = { status: m ? m.status : "taking" };
  const name = h("input", { type: "text", value: m?.name || "" });
  const strength = h("input", { type: "text", value: m?.strength || "" });
  const dose = h("input", { type: "text", value: m?.dose || "" });
  const freq = h("input", { type: "text", value: m?.frequency || "", placeholder: "e.g. BD" });
  const since = h("input", { type: "text", value: m?.since || "" });
  const verified = h("input", { type: "checkbox", checked: !m });
  const err = h("div", { class: "err" });
  return modal(m ? "Edit reported medicine" : "Reported current medicine", [field("Medicine", name), h("div", { class: "grid2" }, field("Strength", strength), field("Dose", dose)), h("div", { class: "grid2" }, field("Frequency", freq), field("Since", since)), field("Status", segmented([{ value: "taking", label: "Taking" }, { value: "stopped", label: "Stopped" }, { value: "unknown", label: "Unsure" }, ...(m ? [{ value: "entered_in_error", label: "Entered in error" }] : [])], st.status, (v) => (st.status = v))), h("label", { class: "check" }, verified, " Verified with the patient today"), err], [
    { label: "Cancel", result: false },
    { label: "Save", kind: "primary", value: () => app.store.saveMedication({ id: m?.id, patientId: p.id, name: name.value, strength: strength.value, dose: dose.value, frequency: freq.value, since: since.value, status: st.status, verified: verified.checked }).then(() => true).catch((e) => { err.textContent = e.message; return undefined; }) },
  ]);
}

// ---------------------------------------------------------- visits (finance)

function visitsTab(app, p) {
  const store = app.store;
  const vs = store.data.visits.filter((v) => v.patientRecordId === p.id && !v.voided).sort((a, b) => (a.date < b.date ? 1 : -1));
  const L_ = store.ledger;
  return h(
    "div",
    { class: "card" },
    h("h3", null, "Visits & fees"),
    vs.length
      ? vs.map((v) => {
          const f = L_.visitFin.get(v.id);
          const enc = store.encounterForVisit(v.id);
          return h("button", { class: "row click" + (v.cancelled ? " struck" : ""), onclick: () => app.go("session", { id: v.sessionId }) }, h("div", null, h("b", null, date(v.date), " · ", store.locationName(v.locationId)), h("div", { class: "small muted" }, v.categoryLabel, enc ? " · clinical record ✓" : "")), h("div", { class: "right" }, h("b", null, f ? money(f.net) : ""), f && f.outstanding > 0 ? badge(money(f.outstanding) + " due", "warn") : null));
        })
      : h("p", { class: "small muted" }, "No visits linked to this patient yet."),
    h("p", { class: "small muted" }, "Fees and payments stay in the financial ledger. Clinical records never change them."),
  );
}

export { confirmDialog, askReason, DIAGNOSIS_KINDS };
