// Clinical consultation: start (with explicit billing choice), editor, sign-off, note.
import { h, add, clear, money, date, field, moneyInput, dateInput, segmented, select, toast, modal, confirmDialog, askReason, attempt, badge, downloadFile } from "./dom.js";
import { today, fmtDateTime } from "../dates.js";
import { rateFor } from "../calc.js";
import { METHODS, SESSION_NAMES, ENCOUNTER_TYPES, COMMON_COMPLAINTS, COMORBIDITIES, EXAM_STATUS, DIAGNOSIS_KINDS, CERTAINTY, INVESTIGATION_CATEGORIES, COMMON_INVESTIGATIONS, ROUTES, FREQUENCIES_RX, TIMINGS, GLUCOSE_CONTEXT, GLUCOSE_SOURCE, ALLOWED_UPLOADS } from "../model.js";
import { ageLabel, searchPatients, problemList, formatVital, vitalLabel, bmiFrom, followUpDate, noteToText, medicationNeedsVerification } from "../clinical.js";
import { fileLink } from "./patients.js";
import { scanCard } from "./scan.js";
import { cap } from "./entry.js";

const dl = (id, items) => h("datalist", { id }, items.map((x) => h("option", { value: x })));
const nowTime = () => {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};

// ------------------------------------------------------------------ start

export function renderNewEncounter(app, params) {
  const store = app.store;
  const fixedVisit = params.visitId ? store.get("visits", params.visitId) : null;
  const st = {
    patientId: params.patientId || fixedVisit?.patientRecordId || null,
    date: fixedVisit ? fixedVisit.date : today(),
    time: nowTime(),
    locationId: fixedVisit ? fixedVisit.locationId : store.settings.lastLocationId || store.locationsSorted()[0]?.id,
    sessionName: fixedVisit ? store.get("sessions", fixedVisit.sessionId)?.sessionName : store.settings.lastSessionName || "morning",
    type: "opd",
    workflow: "quick",
    doctorId: store.session?.role === "doctor" ? store.session.userId : store.data.users.find((u) => u.role === "doctor")?.id,
    mode: fixedVisit ? "link" : "new",
    visitId: fixedVisit?.id || null,
    category: "new",
    pay: "none",
    method: "cash",
    sessionId: null,
  };
  const root = h("div", { class: "screen" });
  const patientBox = h("div");
  const billBox = h("div");
  const err = h("div", { class: "err" });

  const drawPatient = () => {
    clear(patientBox);
    const p = st.patientId && store.get("patients", st.patientId);
    if (p) {
      add(patientBox, h("div", { class: "card" }, h("b", null, p.name), " · ", ageLabel(p), " · ", p.id, " ", fixedVisit ? null : h("button", { class: "link small", onclick: () => { st.patientId = null; drawPatient(); } }, "change")));
      return;
    }
    const q = h("input", { type: "search", placeholder: "Search name, mobile, patient ID", autocomplete: "off" });
    const res = h("div");
    const run = () => {
      clear(res);
      if (!q.value.trim()) return;
      for (const x of searchPatients(store.data.patients, q.value).slice(0, 8)) add(res, h("button", { class: "row click", onclick: () => { st.patientId = x.id; drawPatient(); } }, h("div", null, h("b", null, x.name), h("div", { class: "small muted" }, ageLabel(x), " · ", x.id, x.mobile ? " · ☎ " + x.mobile : ""))));
      add(res, h("button", { class: "btn small", onclick: () => app.go("patientForm", { name: q.value }) }, "+ Register new patient"));
    };
    q.addEventListener("input", run);
    add(patientBox, h("div", { class: "card" }, field("Patient", q), res));
    setTimeout(() => q.focus(), 30);
  };

  const drawBilling = () => {
    clear(billBox);
    const loc = store.get("locations", st.locationId);
    add(billBox, field("Consultation fee", segmented([
      { value: "new", label: "Record fee now" },
      { value: "link", label: "Already billed (link visit)" },
      { value: "none", label: "No fee" },
    ], st.mode, (v) => { st.mode = v; drawBilling(); })));
    if (st.mode === "new") {
      const rate = loc && rateFor(store.data.rates, loc.id, st.date);
      if (!rate) return add(billBox, h("p", { class: "err" }, "No fees set for this location. Choose another, or 'No fee'."));
      if (!rate.categories.some((c) => c.key === st.category)) st.category = rate.categories[0].key;
      const cat = rate.categories.find((c) => c.key === st.category);
      const hospital = loc.arrangement === "hospital";
      add(
        billBox,
        field("Visit type", segmented(rate.categories.map((c) => ({ value: c.key, label: `${c.label} ${money(c.feePaise)}` })), st.category, (v) => { st.category = v; drawBilling(); })),
        hospital
          ? h("p", { class: "small muted" }, "Hospital collects the fee here.")
          : [field("Payment", segmented([{ value: "full", label: `Paid ${money(cat.feePaise)}` }, { value: "none", label: "Not paid yet" }], st.pay, (v) => { st.pay = v; drawBilling(); })), st.pay === "full" ? field("paymentMethod", segmented(Object.entries(METHODS).map(([value, label]) => ({ value, label })), st.method, (v) => (st.method = v))) : null],
        h("p", { class: "small muted" }, "Creates one visit in the financial ledger, linked to this consultation."),
      );
    } else if (st.mode === "link") {
      const linked = new Set(store.data.encounters.filter((e) => e.status !== "cancelled").map((e) => e.visitId));
      const vs = store.data.visits.filter((v) => !v.voided && !v.cancelled && v.date === st.date && (!st.locationId || v.locationId === st.locationId) && !linked.has(v.id) && (!v.patientRecordId || v.patientRecordId === st.patientId));
      if (fixedVisit) add(billBox, h("p", null, "Linked to visit ", fixedVisit.id));
      else if (!vs.length) add(billBox, h("p", { class: "small muted" }, "No unlinked visits for this date and location."));
      else add(billBox, field("Visit", select([{ value: "", label: "— choose —" }, ...vs.map((v) => ({ value: v.id, label: `${cap(store.get("sessions", v.sessionId)?.sessionName)} · ${v.categoryLabel} · ${v.patientId || v.patientName || v.id}` }))], st.visitId || "", (v) => (st.visitId = v))));
    } else {
      const ss = store.data.sessions.filter((s) => !s.voided && s.date === st.date && s.locationId === st.locationId);
      add(billBox, h("p", { class: "small muted" }, "No financial record is created (e.g. ward round, free follow-up, or a patient already counted in a session summary)."), ss.length ? field("Count under session (optional, no charge)", select([{ value: "", label: "— none —" }, ...ss.map((s) => ({ value: s.id, label: `${cap(s.sessionName)} · ${s.mode === "summary" ? "summary" : "individual"}` }))], st.sessionId || "", (v) => (st.sessionId = v || null))) : null);
    }
  };

  const create = async () => {
    err.textContent = "";
    if (!st.patientId) return (err.textContent = "Choose the patient.");
    const billing = st.mode === "new"
      ? { mode: "new", category: st.category, collector: "me", payment: st.pay === "full" ? { amountPaise: rateFor(store.data.rates, st.locationId, st.date).categories.find((c) => c.key === st.category).feePaise, method: st.method } : null }
      : st.mode === "link" ? { mode: "link", visitId: st.visitId } : { mode: "none" };
    if (st.mode === "link" && !st.visitId) return (err.textContent = "Choose the visit to link.");
    const e = await attempt(() => store.createEncounter({ patientId: st.patientId, date: st.date, time: st.time, locationId: st.locationId, sessionName: st.sessionName, sessionId: st.sessionId, type: st.type, workflow: st.workflow, doctorId: st.doctorId, billing }));
    if (!e) return;
    await store.saveSettings({ lastLocationId: st.locationId, lastSessionName: st.sessionName });
    app.go("encounter", { id: e.id }, { replace: true });
  };

  const doctors = store.data.users.filter((u) => u.role === "doctor" && u.active !== false);
  add(
    root,
    h("h1", null, "New consultation"),
    patientBox,
    h(
      "div",
      { class: "card" },
      h("div", { class: "grid2" }, field("date", dateInput(st.date, (v) => { st.date = v; drawBilling(); })), field("Time", h("input", { type: "time", value: st.time, onchange: (e) => (st.time = e.target.value) }))),
      fixedVisit ? h("p", null, h("b", null, store.locationName(st.locationId))) : field("location", h("div", { class: "pills" }, store.locationsSorted().map((l) => h("button", { type: "button", class: "pill" + (l.id === st.locationId ? " on" : ""), onclick: (ev) => { st.locationId = l.id; ev.currentTarget.parentNode.querySelectorAll(".pill").forEach((b) => b.classList.remove("on")); ev.currentTarget.classList.add("on"); drawBilling(); } }, l.name)))),
      fixedVisit ? null : field("session", segmented(SESSION_NAMES.map((n) => ({ value: n, label: cap(n) })), st.sessionName, (v) => (st.sessionName = v))),
      h("div", { class: "grid2" }, field("Type", select(Object.entries(ENCOUNTER_TYPES).map(([value, label]) => ({ value, label })), st.type, (v) => (st.type = v))), field("Treating doctor", select(doctors.map((d) => ({ value: d.id, label: d.name })), st.doctorId, (v) => (st.doctorId = v)))),
      field("Workflow", segmented([{ value: "quick", label: "Quick" }, { value: "detailed", label: "Detailed" }], st.workflow, (v) => (st.workflow = v))),
    ),
    h("div", { class: "card" }, billBox),
    err,
    h("div", { class: "actions sticky" }, h("button", { class: "btn", onclick: () => app.back() }, "Cancel"), h("button", { class: "btn primary big", onclick: create }, "Start consultation")),
  );
  drawPatient();
  drawBilling();
  return root;
}

// ----------------------------------------------------------------- editor

const STATUS_BADGE = { draft: ["Draft", "warn"], amending: ["Amending", "warn"], finalized: ["Signed", "ok"], cancelled: ["Cancelled", "mid"] };

export function renderEncounter(app, { id }) {
  const store = app.store;
  if (!store.can("clinical.read")) return staffView(app, id);
  const b = store.encounterBundle(id);
  const e = structuredClone(b.encounter);
  const ctx = b.context;
  const p = ctx.patient;
  const editable = e.status === "draft" || e.status === "amending";
  const detailed = e.workflow === "detailed";
  const root = h("div", { class: "screen encounter" });
  const saveState = h("span", { class: "small muted" });
  let timer = null;
  let pending = false;

  const save = async () => {
    clearTimeout(timer);
    if (!pending) return;
    pending = false;
    saveState.textContent = "Saving…";
    try {
      await store.updateEncounter(id, { complaints: e.complaints, history: e.history, exam: e.exam, assessment: e.assessment, plan: e.plan, advice: e.advice, followUp: e.followUp, notes: e.notes, type: e.type, workflow: e.workflow });
      saveState.textContent = "Draft saved ✓";
      root.dataset.dirty = "0";
    } catch (err) {
      saveState.textContent = "Not saved: " + err.message;
      pending = true;
    }
  };
  const changed = () => {
    pending = true;
    root.dataset.dirty = "1";
    saveState.textContent = "Unsaved…";
    clearTimeout(timer);
    timer = setTimeout(save, 700);
  };
  // Every re-render first flushes the draft so no typing is lost.
  const rerender = async () => {
    await save();
    app.go("encounter", { id }, { replace: true });
  };
  const text = (obj, key, attrs = {}) => {
    const el = h(attrs.rows ? "textarea" : "input", { type: "text", value: obj[key] || "", disabled: !editable, ...attrs });
    el.addEventListener("input", () => { obj[key] = el.value; changed(); });
    return el;
  };

  // Banner
  const allergies = ctx.allergies.filter((a) => a.status === "active");
  const probs = problemList(store.data.diagnoses.filter((d) => d.patientId === p.id && d.encounterId !== id));
  const visit = e.visitId && store.get("visits", e.visitId);
  const vf = visit && store.ledger.visitFin.get(visit.id);
  const [sl, sk] = STATUS_BADGE[e.status];
  add(
    root,
    h(
      "div",
      { class: "card patient-head" },
      h("h1", null, h("button", { class: "link big-link", onclick: () => app.go("patient", { id: p.id }) }, p.name), h("small", null, ` · ${ageLabel(p, e.date)} · ${p.sex !== "unknown" ? p.sex : ""} · ${p.id}`)),
      h("div", { class: "small" }, date(e.date), " ", e.time, " · ", store.locationName(e.locationId), " · ", ENCOUNTER_TYPES[e.type], " · ", e.doctorName, " ", badge(sl + (e.version ? ` v${e.version}` : ""), sk)),
      h("div", { class: "badges" }, allergies.length ? allergies.map((a) => badge("⚠ " + a.substance + (a.reaction ? " → " + a.reaction : ""), "bad")) : ctx.profile?.nkda ? badge("NKDA", "ok") : badge("Allergies not recorded", "warn"), ctx.profile?.alerts ? badge("⚑ " + ctx.profile.alerts, "bad") : null),
      probs.length ? h("div", { class: "small" }, h("b", null, "Known problems: "), probs.map((d) => `${d.name} (${CERTAINTY[d.certainty].toLowerCase()})`).join(", ")) : null,
      ctx.conditions.filter((c) => c.category === "medical" && c.status === "current").length ? h("div", { class: "small" }, h("b", null, "Comorbidities: "), ctx.conditions.filter((c) => c.category === "medical" && c.status === "current").map((c) => c.name).join(", ")) : null,
      ctx.medications.filter((m) => m.status === "taking").length ? h("div", { class: "small" }, h("b", null, "Reported medicines: "), ctx.medications.filter((m) => m.status === "taking").map((m) => m.name + (medicationNeedsVerification(m, today()) ? " (verify)" : "")).join(", ")) : null,
      h("div", { class: "small muted" }, visit ? [`Fee: ${visit.categoryLabel} ${money(vf ? vf.net : visit.feePaise)}`, vf && vf.outstanding > 0 ? ` · ${money(vf.outstanding)} due` : "", visit.cancelled ? " · visit cancelled (financial)" : ""] : "No fee recorded for this consultation", e.sessionId ? " · " : "", e.sessionId ? h("button", { class: "link small", onclick: () => app.go("session", { id: e.sessionId }) }, "session") : null),
      e.status === "amending" ? h("p", { class: "badc small" }, "Amending signed version ", e.version, ": ", e.amendReason) : null,
      e.status === "cancelled" ? h("p", { class: "badc" }, "Cancelled: ", e.cancelReason) : null,
    ),
  );

  if (!editable) {
    add(root, signedView(app, b));
    return root;
  }

  add(root, h("div", { class: "row-btns wrap" }, segmented([{ value: "quick", label: "Quick" }, { value: "detailed", label: "Detailed" }], e.workflow, (v) => { e.workflow = v; changed(); rerender(); }), saveState));

  // Complaints
  const cBox = h("div");
  const drawComplaints = () => {
    clear(cBox);
    e.complaints.forEach((c, i) => {
      add(
        cBox,
        h(
          "div",
          { class: "complaint" },
          h("div", { class: "grid2" }, field("Complaint", text(c, "text", { list: "dl-complaints", autocomplete: "off" })), field("Duration", text(c, "duration", { placeholder: "e.g. 3 days" }))),
          detailed ? [h("div", { class: "grid2" }, field("Onset", text(c, "onset", { placeholder: "sudden / gradual" })), field("Progression", text(c, "progression", { placeholder: "worsening / static / improving" }))), h("div", { class: "grid2" }, field("Severity", text(c, "severity")), field("Associated symptoms", text(c, "associated"))), field("Relevant negatives", text(c, "negatives", { placeholder: "e.g. chest pain, vomiting" })), field("Notes", text(c, "notes"))] : field("Notes", text(c, "notes")),
          h("button", { class: "link small", onclick: () => { e.complaints.splice(i, 1); changed(); drawComplaints(); } }, "remove"),
        ),
      );
    });
  };
  drawComplaints();
  const addComplaint = (t = "") => {
    e.complaints.push({ text: t, duration: "", onset: "", progression: "", severity: "", associated: "", negatives: "", notes: "" });
    changed();
    drawComplaints();
    const last = cBox.querySelectorAll(".complaint input")[cBox.querySelectorAll(".complaint").length * (detailed ? 8 : 3) - (detailed ? 7 : 2)];
    if (last) last.focus();
  };
  add(root, section("Chief complaints", [dl("dl-complaints", COMMON_COMPLAINTS), h("div", { class: "chips-row" }, COMMON_COMPLAINTS.slice(0, 12).map((t) => h("button", { type: "button", class: "chip-btn", onclick: () => addComplaint(t) }, "+ " + t))), cBox, h("button", { class: "btn small", onclick: () => addComplaint() }, "+ Add complaint (free text)")], true));

  // History
  if (detailed) {
    e.history = e.history || {};
    add(root, section("History", [field("History of present illness", text(e.history, "hpi", { rows: 3 })), field("Past history (this visit)", text(e.history, "past", { rows: 2 })), field("Surgical history", text(e.history, "surgical", { rows: 1 })), field("Family history", text(e.history, "family", { rows: 1 })), field("Personal history", text(e.history, "personal", { rows: 1 })), field("Lifestyle", text(e.history, "lifestyle", { rows: 1 })), h("p", { class: "small muted" }, "Long-term comorbidities, allergies and medicines are kept in the patient profile. ", h("button", { class: "link small", onclick: () => save().then(() => app.go("patient", { id: p.id })) }, "Open profile"))]));
  }

  // Vitals
  add(root, section("Vitals", vitalsBlock(app, e, b.vitals, rerender), true));

  // Examination
  const exBox = h("div");
  const drawExam = () => {
    clear(exBox);
    for (const x of e.exam) {
      const fBox = h("div", { class: x.status === "not_examined" ? "hide" : "" }, field("Findings", text(x, "findings", { rows: 2 })), detailed ? h("div", { class: "grid2" }, field("Relevant positives", text(x, "positives")), field("Relevant negatives", text(x, "negatives"))) : null);
      add(exBox, h("div", { class: "exam-row" }, h("b", null, x.label), segmented(Object.entries(EXAM_STATUS).map(([value, label]) => ({ value, label })), x.status, (v) => { x.status = v; fBox.classList.toggle("hide", v === "not_examined"); changed(); }), fBox));
    }
  };
  drawExam();
  const examTemplates = store.data.templates.filter((t) => t.kind === "exam");
  add(
    root,
    section("Examination", [
      h("p", { class: "small muted" }, "Every system starts as 'Not examined'. Nothing is marked normal unless you mark it."),
      exBox,
      h(
        "div",
        { class: "row-btns wrap" },
        h("button", { class: "btn small", onclick: async () => { const n = await askReason("Custom examination section", "Section name (e.g. Thyroid, Breast, Eye)", { ok: "Add", placeholder: "Section name" }); if (n) { e.exam.push({ key: "custom-" + Date.now().toString(36), label: n, status: "not_examined", findings: "", positives: "", negatives: "" }); changed(); drawExam(); } } }, "+ Custom section"),
        examTemplates.length ? select([{ value: "", label: "Apply exam template…" }, ...examTemplates.map((t) => ({ value: t.id, label: t.name }))], "", (tid) => {
          const t = examTemplates.find((x) => x.id === tid);
          if (!t) return;
          for (const tx of t.data) {
            const row = e.exam.find((x) => x.key === tx.key) || (e.exam.push({ key: tx.key, label: tx.label, status: "not_examined", findings: "", positives: "", negatives: "" }), e.exam[e.exam.length - 1]);
            Object.assign(row, { status: tx.status, findings: tx.findings, positives: tx.positives || "", negatives: tx.negatives || "" });
          }
          changed();
          drawExam();
          toast("Template applied — review each section before signing.");
        }) : null,
        h("button", { class: "btn small", onclick: async () => { const n = await askReason("Save examination as template", "Template name", { ok: "Save", placeholder: "e.g. Normal adult screening" }); if (n) attempt(() => store.saveTemplate({ kind: "exam", name: n, data: e.exam.filter((x) => x.status !== "not_examined") })).then((t) => t && toast("Template saved ✓")); } }, "Save as template"),
      ),
    ], true),
  );

  // Scanned paper prescriptions for this consultation
  const scans = store.data.scans.filter((x) => x.encounterId === id);
  add(root, section("Scanned prescription", [h("p", { class: "small muted" }, "Photograph or upload a paper prescription. Its contents are read for you to check field by field; nothing enters this consultation until you approve and import it."), scans.map((sc) => scanCard(app, sc)), h("button", { class: "btn small", onclick: () => save().then(() => app.go("scan", { patientId: p.id, encounterId: id })) }, "📷 Scan / upload prescription")], !!scans.length));

  // Investigations
  add(root, section("Investigations & reports", [b.investigations.length ? b.investigations.map((i) => h("div", { class: "row" }, h("div", { class: "grow" }, h("b", null, i.name), " ", i.value ? `${i.value} ${i.unit}` : i.status === "ordered" ? badge("ordered", "mid") : "", i.refRange ? h("small", { class: "muted" }, ` (ref ${i.refRange})`) : "", h("div", { class: "small muted" }, date(i.resultAt || i.orderedAt), i.interpretation ? " · " + i.interpretation : ""), b.files.filter((f) => f.investigationId === i.id).map((f) => fileLink(app, f))), h("button", { class: "link small", onclick: () => save().then(() => investigationDialog(app, p.id, id, i)).then((ok) => ok && rerender()) }, i.status === "ordered" ? "add result" : "notes / files"))) : h("p", { class: "small muted" }, "None for this consultation."), h("button", { class: "btn small", onclick: () => save().then(() => investigationDialog(app, p.id, id)).then((ok) => ok && rerender()) }, "+ Order / record investigation")]));

  // Diagnoses
  const dxNames = [...new Set([...COMORBIDITIES, ...store.data.diagnoses.map((d) => d.name).filter(Boolean)])];
  add(
    root,
    section("Diagnosis & assessment", [
      dl("dl-dx", dxNames),
      h("p", { class: "small muted" }, "Complaints, abnormal vitals and results are not converted into diagnoses. Choose the certainty for each."),
      b.diagnoses.filter((d) => !d.voided).map((d) => h("div", { class: "row" }, h("div", { class: "grow" }, h("b", null, DIAGNOSIS_KINDS[d.kind], ": ", d.name), " ", badge(CERTAINTY[d.certainty], d.certainty === "confirmed" ? "ok" : "mid"), d.reviewOf ? h("small", { class: "muted" }, " · review of earlier diagnosis") : null, h("div", { class: "small muted" }, [d.severity, d.code, d.notes].filter(Boolean).join(" · "))), h("div", { class: "right" }, h("button", { class: "link small", onclick: () => save().then(() => diagnosisDialog(app, e, d)).then((ok) => ok && rerender()) }, "edit"), h("button", { class: "link small", onclick: () => attempt(() => store.removeDiagnosis(d.id)).then(rerender) }, "remove")))),
      h("div", { class: "row-btns wrap" }, h("button", { class: "btn small", onclick: () => save().then(() => diagnosisDialog(app, e)).then((ok) => ok && rerender()) }, "+ Add diagnosis"), probs.length ? select([{ value: "", label: "Review earlier diagnosis…" }, ...probs.map((d) => ({ value: d.id, label: `${d.name} (${CERTAINTY[d.certainty]}, ${date(store.get("encounters", d.encounterId)?.date)})` }))], "", (did) => did && save().then(() => diagnosisDialog(app, e, null, store.get("diagnoses", did))).then((ok) => ok && rerender())) : null),
      field("Clinical assessment", text(e, "assessment", { rows: 2 })),
      field("Clinical reasoning & plan", text(e, "plan", { rows: 2 })),
    ], true),
  );

  // Treatment
  add(root, section("Treatment & prescription", rxBlock(app, e, b.prescriptions, ctx, save, rerender), true));

  // Advice & follow-up
  e.advice = e.advice || {};
  e.followUp = e.followUp || {};
  const fuDate = dateInput(e.followUp.date || "", (v) => { e.followUp.date = v; changed(); });
  add(
    root,
    section("Advice", [field("Non-drug advice", text(e.advice, "nonPharm", { rows: 2 })), field("Diet & lifestyle", text(e.advice, "diet", { rows: 2 })), detailed ? [field("Procedures", text(e.advice, "procedures")), field("Monitoring", text(e.advice, "monitoring"))] : null, field("Warning signs — return immediately if", text(e.advice, "warningSigns", { rows: 2 })), field("Referral / admission", text(e.advice, "referral"))], true),
    section("Follow-up", [h("div", { class: "chips-row" }, ["3d", "1w", "2w", "1m", "3m", "6m"].map((iv) => h("button", { type: "button", class: "chip-btn", onclick: () => { e.followUp.interval = iv.replace("d", " days").replace("w", " week" + (iv === "1w" ? "" : "s")).replace("m", " month" + (iv === "1m" ? "" : "s")); e.followUp.date = followUpDate(e.date, iv); fuDate.value = e.followUp.date; changed(); } }, iv)), h("button", { type: "button", class: "chip-btn", onclick: () => { e.followUp.interval = "SOS"; e.followUp.date = ""; fuDate.value = ""; changed(); } }, "SOS")), h("div", { class: "grid2" }, field("Interval", text(e.followUp, "interval")), field("Date", fuDate)), field("Instructions", text(e.followUp, "instructions"))], true),
    section("Notes", [field("Free notes (Hindi or English)", text(e, "notes", { rows: 3, lang: "hi-IN" }))]),
  );

  add(
    root,
    h(
      "div",
      { class: "actions sticky" },
      h("button", { class: "btn", onclick: () => save().then(() => app.go("note", { id })) }, "Preview note"),
      store.can("clinical.sign")
        ? h("button", { class: "btn primary big", onclick: async () => {
            await save();
            if (!(await confirmDialog("Sign consultation", "Sign and lock this consultation? Later corrections will be recorded as an amendment with a reason."))) return;
            const r = await attempt(() => store.finalizeEncounter(id));
            if (r) { toast("Signed ✓"); app.go("note", { id }, { replace: true }); }
          } }, e.status === "amending" ? "Sign amendment" : "Sign & finish")
        : null,
    ),
    h("div", { class: "row-btns" }, h("button", { class: "btn danger-o small", onclick: () => cancelFlow(app, e) }, "Cancel consultation")),
  );
  return root;
}

function section(title, body, open) {
  return h("details", { class: "card sec-card", open: open || null }, h("summary", null, h("h3", null, title)), body);
}

async function cancelFlow(app, e) {
  const r = await askReason("Cancel consultation", "The clinical record is marked cancelled (kept for the audit trail). The fee is handled separately.", { ok: "Cancel consultation", danger: true });
  if (r === null) return;
  if (!(await attempt(() => app.store.cancelEncounter(e.id, r).then(() => true)))) return;
  const v = e.visitId && app.store.get("visits", e.visitId);
  if (v && !v.cancelled && app.store.perms.includes("finance") && (await confirmDialog("Also cancel the fee?", "The linked visit is still counted as a consultation with its fee. Cancel the visit in the financial ledger too?", { ok: "Cancel the fee too", danger: true }))) {
    await attempt(() => app.store.cancelVisit(v.id, "Consultation cancelled: " + r));
  }
  app.go("patient", { id: e.patientId }, { replace: true });
}

// ------------------------------------------------------------------ vitals

function vitalsBlock(app, e, vitals, rerender) {
  const store = app.store;
  const live = vitals.filter((v) => !v.voided).sort((a, b) => (a.takenAt < b.takenAt ? -1 : 1));
  const num = (ph, w = "") => h("input", { type: "text", inputmode: "decimal", placeholder: ph, class: "vin " + w });
  const f = { sys: num("sys"), dia: num("dia"), pulse: num("/min"), rr: num("/min"), temp: num("°C"), spo2: num("%"), weight: num("kg"), height: num("cm"), glucose: num("mg/dL"), pain: num("0-10") };
  const spo2Ctx = h("input", { type: "text", placeholder: "room air / O₂ 2 L/min", value: "room air" });
  let gCtx = "random";
  let gSrc = "capillary";
  const at = h("input", { type: "datetime-local", value: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) });
  const other = { name: h("input", { type: "text", placeholder: "Other (e.g. peak flow)" }), value: h("input", { type: "text", placeholder: "value" }), unit: h("input", { type: "text", placeholder: "unit" }) };
  const err = h("div", { class: "err" });
  const confirmBtn = h("button", { class: "btn danger-o small hide" }, "Values are correct — save anyway");
  const n = (el) => (el.value.trim() === "" ? null : Number(el.value.replace(",", ".")));
  const collect = () => {
    const m = [];
    if (f.sys.value || f.dia.value) m.push({ type: "bp", values: { systolic: n(f.sys), diastolic: n(f.dia) } });
    for (const k of ["pulse", "rr", "temp", "weight", "height", "pain"]) if (f[k].value.trim()) m.push({ type: k, value: n(f[k]) });
    if (f.spo2.value.trim()) m.push({ type: "spo2", value: n(f.spo2), context: spo2Ctx.value });
    if (f.glucose.value.trim()) m.push({ type: "glucose", value: n(f.glucose), context: gCtx, source: gSrc });
    if (other.name.value.trim()) m.push({ type: "other", name: other.name.value, value: other.value.value, unit: other.unit.value });
    return m;
  };
  const go = async (confirmUnusual) => {
    err.textContent = "";
    confirmBtn.classList.add("hide");
    try {
      await store.addVitals(e.id, collect(), { takenAt: at.value, confirmUnusual });
      toast("Vitals saved ✓");
      rerender();
    } catch (x) {
      err.textContent = x.message;
      if (/Check these values/.test(x.message)) confirmBtn.classList.remove("hide");
    }
  };
  confirmBtn.onclick = () => go(true);
  const b = bmiFrom(live);
  return [
    live.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "tbl" }, h("tbody", null, live.map((v) => h("tr", null, h("td", null, v.takenAt.slice(11, 16)), h("td", null, vitalLabel(v)), h("td", { class: "num" }, formatVital(v)), h("td", { class: "small" }, (v.flags || []).map((x) => h("span", { class: "flag" }, x))), h("td", null, h("button", { class: "link small", onclick: async () => { const r = await askReason("Void reading", `${vitalLabel(v)} ${formatVital(v)} — entered in error? The value stays in the record, marked void.`, { ok: "Void", danger: true }); if (r !== null && (await attempt(() => store.voidVital(v.id, r).then(() => true)))) rerender(); } }, "void")))))))
      : null,
    b ? h("p", { class: "small" }, "BMI ", h("b", null, b), " kg/m² (from latest height and weight)") : null,
    vitals.some((v) => v.voided) ? h("details", { class: "small muted" }, h("summary", null, "Voided readings"), vitals.filter((v) => v.voided).map((v) => h("div", null, `${v.takenAt.slice(11, 16)} ${vitalLabel(v)} ${formatVital(v)} — ${v.voidReason}`))) : null,
    h(
      "div",
      { class: "vitals-form" },
      h("div", { class: "vgrid" }, h("label", null, "BP", h("span", { class: "bp" }, f.sys, "/", f.dia)), h("label", null, "Pulse", f.pulse), h("label", null, "SpO₂", f.spo2), h("label", null, "Temp", f.temp), h("label", null, "RR", f.rr), h("label", null, "Weight", f.weight), h("label", null, "Height", f.height), h("label", null, "Glucose", f.glucose), h("label", null, "Pain", f.pain)),
      field("SpO₂ context", spo2Ctx),
      h("div", { class: "grid2" }, field("Glucose timing", select(Object.entries(GLUCOSE_CONTEXT).map(([value, label]) => ({ value, label })), gCtx, (v) => (gCtx = v))), field("Glucose source", select(Object.entries(GLUCOSE_SOURCE).map(([value, label]) => ({ value, label })), gSrc, (v) => (gSrc = v)))),
      h("div", { class: "grid3" }, other.name, other.value, other.unit),
      field("Measured at", at),
      err,
      h("div", { class: "row-btns wrap" }, h("button", { class: "btn primary small", onclick: () => go(false) }, "Save readings"), confirmBtn),
      h("p", { class: "small muted" }, "Each reading is kept with its time; new readings never replace earlier ones. Flags are prompts to review, not diagnoses."),
    ),
  ];
}

// --------------------------------------------------------------- diagnoses

function diagnosisDialog(app, e, d, reviewOf) {
  const base = d || reviewOf;
  const st = { kind: base ? base.kind : "primary", certainty: d ? d.certainty : "provisional", status: d ? d.status : "active" };
  const name = h("input", { type: "text", list: "dl-dx", autocomplete: "off", value: base?.name || "" });
  const sev = h("input", { type: "text", value: base?.severity || "", placeholder: "severity / stage (optional)" });
  const code = h("input", { type: "text", value: base?.code || "", placeholder: "ICD-10 (optional)" });
  const notes = h("input", { type: "text", value: d?.notes || "" });
  const err = h("div", { class: "err" });
  return modal(reviewOf ? "Review earlier diagnosis" : d ? "Edit diagnosis" : "Add diagnosis", [
    reviewOf ? h("p", { class: "small muted" }, `Earlier: ${reviewOf.name} — ${CERTAINTY[reviewOf.certainty]} on ${date(app.store.get("encounters", reviewOf.encounterId)?.date)}. The earlier record is kept unchanged.`) : null,
    field("Diagnosis", name),
    field("Type", segmented(Object.entries(DIAGNOSIS_KINDS).map(([value, label]) => ({ value, label })), st.kind, (v) => (st.kind = v))),
    field("Certainty", segmented(Object.entries(CERTAINTY).map(([value, label]) => ({ value, label })), st.certainty, (v) => (st.certainty = v))),
    field("Status", segmented([{ value: "active", label: "Active" }, { value: "resolved", label: "Resolved" }], st.status, (v) => (st.status = v))),
    h("div", { class: "grid2" }, field("Severity / stage", sev), field("Code", code)),
    field("Notes", notes),
    err,
  ], [
    { label: "Cancel", result: false },
    { label: "Save", kind: "primary", value: () => app.store.saveDiagnosis({ id: d?.id, encounterId: e.id, kind: st.kind, name: name.value, certainty: st.certainty, status: st.status, severity: sev.value, code: code.value, notes: notes.value, reviewOf: reviewOf?.id || d?.reviewOf || null }).then(() => true).catch((x) => { err.textContent = x.message; return undefined; }) },
  ]);
}

// ---------------------------------------------------------- investigations

export function investigationDialog(app, patientId, encounterId, inv) {
  const store = app.store;
  const hasResult = inv && (inv.value || inv.resultAt);
  const st = { category: inv ? inv.category : "other" };
  const name = h("input", { type: "text", list: "dl-inv", autocomplete: "off", value: inv?.name || "", disabled: !!inv });
  const catSel = select(Object.entries(INVESTIGATION_CATEGORIES).map(([value, label]) => ({ value, label })), st.category, (v) => (st.category = v), { disabled: !!inv || null });
  name.addEventListener("change", () => {
    const hit = COMMON_INVESTIGATIONS.find((x) => x[0] === name.value);
    if (hit) { st.category = hit[1]; catSel.value = hit[1]; if (!unit.value) unit.value = hit[2]; }
  });
  const ordered = dateInput(inv?.orderedAt || (encounterId ? today() : ""));
  const performed = dateInput(inv?.performedAt || "");
  const resultAt = dateInput(inv?.resultAt || "");
  const value = h("input", { type: "text", value: inv?.value || "", disabled: !!hasResult });
  const unit = h("input", { type: "text", value: inv?.unit || "", disabled: !!hasResult });
  const ref = h("input", { type: "text", value: inv?.refRange || "", disabled: !!hasResult, placeholder: "as printed on the report" });
  const interp = h("textarea", { rows: 2, value: inv?.interpretation || "" });
  const files = h("input", { type: "file", multiple: true, accept: Object.keys(ALLOWED_UPLOADS).join(",") + ",.pdf,.jpg,.jpeg,.png,.webp" });
  const err = h("div", { class: "err" });
  return modal(inv ? inv.name : "Investigation / report", [
    dl("dl-inv", COMMON_INVESTIGATIONS.map((x) => x[0])),
    field("Investigation", name),
    field("Category", catSel),
    h("div", { class: "grid3" }, field("Ordered", ordered), field("Performed", performed), field("Result date", resultAt)),
    hasResult ? h("p", { class: "small muted" }, "The recorded result cannot be changed. Add a new result for a repeat test.") : null,
    h("div", { class: "grid3" }, field("Result", value), field("Unit", unit), field("Reference range", ref)),
    field("Interpretation / notes", interp),
    field("Attach report (PDF, JPEG, PNG, WebP; max 15 MB each)", files),
    err,
  ], [
    { label: "Cancel", result: false },
    {
      label: "Save",
      kind: "primary",
      value: async () => {
        try {
          const saved = await store.saveInvestigation({ id: inv?.id, patientId, encounterId, name: name.value, category: st.category, orderedAt: ordered.value || null, performedAt: performed.value || null, resultAt: resultAt.value || null, value: value.value, unit: unit.value, refRange: ref.value, interpretation: interp.value });
          for (const f of files.files) {
            const bytes = new Uint8Array(await f.arrayBuffer());
            await store.attachFile({ patientId, encounterId, investigationId: saved.id, name: f.name, bytes, category: st.category });
          }
          toast("Saved ✓");
          return true;
        } catch (x) {
          err.textContent = x.message;
          return undefined;
        }
      },
    },
  ]);
}

// ------------------------------------------------------------ prescriptions

function rxBlock(app, e, prescriptions, ctx, save, rerender) {
  const store = app.store;
  const live = prescriptions.filter((r) => r.status === "draft" || r.status === "approved");
  const draft = live.find((r) => r.status === "draft");
  const approved = live.filter((r) => r.status === "approved");
  const favs = store.data.templates.filter((t) => t.kind === "medicine");
  const rxTemplates = store.data.templates.filter((t) => t.kind === "prescription");
  const items = draft ? structuredClone(draft.items) : [];
  const tbl = h("div");
  let rxId = draft?.id || null;
  let saving = Promise.resolve();
  const persist = () => {
    saving = saving.then(async () => {
      const r = await attempt(() => store.savePrescription({ id: rxId || undefined, encounterId: e.id, items }));
      if (r) rxId = r.id;
    });
    return saving;
  };
  let t2 = null;
  const changed = () => {
    clearTimeout(t2);
    t2 = setTimeout(persist, 700);
  };
  const cell = (it, k, attrs = {}) => {
    const el = h("input", { type: "text", value: it[k] || "", ...attrs });
    el.addEventListener("input", () => { it[k] = el.value; changed(); });
    return el;
  };
  const drawItems = () => {
    clear(tbl);
    items.forEach((it, i) =>
      add(
        tbl,
        h(
          "div",
          { class: "rx-item" },
          h("div", { class: "grid2" }, field(`${i + 1}. Medicine (generic / brand)`, cell(it, "drug", { list: "dl-meds", autocomplete: "off" })), field("Strength", cell(it, "strength", { placeholder: "e.g. 500 mg" }))),
          h("div", { class: "grid3" }, field("Dose", cell(it, "dose", { placeholder: "1 tab" })), field("Route", cell(it, "route", { list: "dl-routes" })), field("Frequency", cell(it, "frequency", { list: "dl-freq" }))),
          h("div", { class: "grid3" }, field("Timing", cell(it, "timing", { list: "dl-timing" })), field("Duration", cell(it, "duration", { placeholder: "5 days" })), field("Quantity", cell(it, "quantity"))),
          field("Special instructions", cell(it, "instructions")),
          h("div", { class: "row-btns wrap" }, h("button", { class: "link small", onclick: () => { items.splice(i, 1); changed(); drawItems(); } }, "remove"), h("button", { class: "link small", onclick: () => it.drug && attempt(() => store.saveTemplate({ kind: "medicine", name: [it.drug, it.strength].filter(Boolean).join(" "), data: { ...it, startDate: null, stopDate: null } })).then((t) => t && toast("Added to favourites ✓")) }, "☆ save as favourite")),
        ),
      ),
    );
  };
  drawItems();
  const addItem = (base = {}) => {
    items.push({ drug: "", strength: "", dose: "", route: "Oral", frequency: "", timing: "", duration: "", quantity: "", instructions: "", startDate: e.date, stopDate: null, ...base, startDate: e.date });
    changed();
    drawItems();
  };
  return [
    dl("dl-meds", [...new Set(favs.map((f) => f.data.drug))]),
    dl("dl-routes", ROUTES),
    dl("dl-freq", FREQUENCIES_RX),
    dl("dl-timing", TIMINGS),
    ctx.medications.filter((m) => m.status === "taking").length ? h("p", { class: "small muted" }, "Already taking (reported, not prescribed here): ", ctx.medications.filter((m) => m.status === "taking").map((m) => m.name).join(", ")) : null,
    approved.map((r) =>
      h(
        "div",
        { class: "card ok" },
        h("b", null, "Approved prescription", r.version > 1 ? ` (version ${r.version})` : ""),
        h("small", { class: "muted" }, " · ", r.approvedBy, " · ", fmtDateTime(r.approvedAt)),
        r.items.map((it, i) => h("div", null, `${i + 1}. `, h("b", null, it.drug), " ", [it.strength, it.dose, it.route, it.frequency, it.timing, it.duration && "× " + it.duration, it.quantity && "qty " + it.quantity, it.instructions].filter(Boolean).join(" · "))),
        draft ? null : h("div", { class: "row-btns wrap" }, h("button", { class: "btn small", onclick: () => save().then(() => store.savePrescription({ id: r.id, encounterId: e.id, items: r.items })).then(rerender).catch((x) => toast(x.message, "err")) }, "Edit (new version)"), h("button", { class: "link small", onclick: async () => { if (await confirmDialog("Cancel prescription", "Mark this prescription cancelled? It stays in the record.", { danger: true, ok: "Cancel prescription" })) attempt(() => store.discardPrescription(r.id, "Cancelled by doctor")).then(rerender); } }, "cancel")),
      ),
    ),
    approved.length && !draft ? null : [
      h("p", { class: "small muted" }, "Nothing is prescribed automatically. Type or pick each medicine, then approve."),
      tbl,
      h(
        "div",
        { class: "row-btns wrap" },
        h("button", { class: "btn small", onclick: () => addItem() }, "+ Add medicine"),
        favs.length ? select([{ value: "", label: "Add favourite…" }, ...favs.map((f) => ({ value: f.id, label: f.name }))], "", (fid) => { const f = favs.find((x) => x.id === fid); if (f) addItem(f.data); }) : null,
        rxTemplates.length ? select([{ value: "", label: "Apply template…" }, ...rxTemplates.map((t) => ({ value: t.id, label: t.name }))], "", (tid) => { const t = rxTemplates.find((x) => x.id === tid); if (t) { for (const it of t.data) items.push({ ...it, startDate: e.date }); changed(); drawItems(); toast("Template added — review every line."); } }) : null,
        items.length ? h("button", { class: "btn small", onclick: async () => { const n = await askReason("Save prescription template", "Template name", { ok: "Save", placeholder: "e.g. Viral fever adult" }); if (n) attempt(() => store.saveTemplate({ kind: "prescription", name: n, data: items.map((it) => ({ ...it, startDate: null, stopDate: null })) })).then((t) => t && toast("Template saved ✓")); } }, "Save as template") : null,
      ),
      store.can("clinical.sign") ? h("div", { class: "row-btns wrap" }, h("button", { class: "btn primary small", onclick: async () => { clearTimeout(t2); await persist(); if (!rxId) return toast("Add a medicine first.", "err"); if (await attempt(() => store.approvePrescription(rxId).then(() => true))) { toast("Prescription approved ✓"); rerender(); } } }, "Approve prescription"), draft ? h("button", { class: "link small", onclick: () => attempt(() => store.discardPrescription(draft.id)).then(rerender) }, "discard draft") : null) : null,
    ],
  ];
}

// ----------------------------------------------------------- signed / staff

function signedView(app, b) {
  const store = app.store;
  const e = b.encounter;
  const v = b.versions[b.versions.length - 1];
  return h(
    "div",
    null,
    v ? h("div", { class: "card" }, noteDom(v.note), h("p", { class: "small muted" }, `Signed by ${v.signedBy} · ${fmtDateTime(v.signedAt)} · version ${v.version}`)) : null,
    h(
      "div",
      { class: "row-btns wrap" },
      h("button", { class: "btn", onclick: () => app.go("note", { id: e.id }) }, "Print / export note"),
      e.status === "finalized" && store.can("clinical.sign") ? h("button", { class: "btn", onclick: async () => { const r = await askReason("Amend signed consultation", "What needs correcting, and why? The signed version is kept; your changes become a new signed version.", { ok: "Start amendment" }); if (r !== null && (await attempt(() => store.amendEncounter(e.id, r).then(() => true)))) app.go("encounter", { id: e.id }, { replace: true }); } }, "Amend") : null,
      e.status !== "cancelled" ? h("button", { class: "btn danger-o small", onclick: () => cancelFlow(app, e) }, "Cancel (entered in error)") : null,
    ),
    b.versions.length > 1 ? h("details", { class: "card" }, h("summary", null, `Version history (${b.versions.length})`), b.versions.map((x) => h("div", { class: "small" }, `v${x.version} · ${x.kind} · ${x.signedBy} · ${fmtDateTime(x.signedAt)}`, x.reason ? ` — ${x.reason}` : ""))) : null,
  );
}

function staffView(app, id) {
  const store = app.store;
  const v = store.staffEncounterView(id);
  const p = store.get("patients", v.encounter.patientId);
  const editable = v.encounter.status === "draft" || v.encounter.status === "amending";
  const rerender = () => app.go("encounter", { id }, { replace: true });
  return h(
    "div",
    { class: "screen" },
    h("div", { class: "card" }, h("h1", null, p.name), h("div", { class: "small" }, ageLabel(p), " · ", p.id, " · ", date(v.encounter.date), " · ", store.locationName(v.encounter.locationId))),
    h("p", { class: "small muted" }, "Staff view: vitals and reports only. Notes, diagnoses and prescriptions are visible to the doctor."),
    editable ? section("Vitals", vitalsBlock(app, { id, ...v.encounter }, v.vitals, rerender), true) : h("p", null, "This consultation is signed; vitals can no longer be added."),
    section("Reports", [v.investigations.map((i) => h("div", null, h("b", null, i.name), " ", i.value ? `${i.value} ${i.unit}` : "", " ", v.files.filter((f) => f.investigationId === i.id).map((f) => fileLink(app, f)))), h("button", { class: "btn small", onclick: () => investigationDialog(app, p.id, id).then((ok) => ok && rerender()) }, "+ Add report")], true),
  );
}

// ---------------------------------------------------------------- note view

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function noteDom(note) {
  return h(
    "div",
    { class: "note" },
    note.header ? h("div", { class: "note-header" }, note.header) : null,
    h("div", { class: "note-patient" }, h("b", null, note.patientLine)),
    h("div", { class: "small" }, note.encounterLine),
    note.sections.map((s) => h("section", null, h("h4", null, s.title), s.parts ? s.parts.map((p) => h("div", null, h("h5", null, p.title), h("ul", null, p.lines.map((l) => h("li", null, l))))) : h("ul", null, s.lines.map((l) => h("li", null, l))))),
  );
}

function noteHtml(note, footer) {
  const sec = note.sections
    .map((s) => `<h3>${esc(s.title)}</h3>` + (s.parts ? s.parts.map((p) => `<h4>${esc(p.title)}</h4><ul>${p.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`).join("") : `<ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`))
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Consultation note</title><style>body{font:14px/1.45 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#111}h3{font-size:14px;margin:16px 0 4px;border-bottom:1px solid #ccc}h4{font-size:13px;margin:8px 0 2px}ul{margin:0;padding-left:18px}.f{margin-top:24px;font-size:12px;color:#555}</style></head><body>${note.header ? `<p>${esc(note.header)}</p>` : ""}<p><b>${esc(note.patientLine)}</b><br>${esc(note.encounterLine)}</p>${sec}<p class="f">${esc(footer)}</p></body></html>`;
}

export function renderNote(app, { id, version }) {
  const store = app.store;
  const b = store.encounterBundle(id);
  const versions = b.versions;
  const chosen = version ? versions.find((v) => v.version === Number(version)) : versions[versions.length - 1];
  const draft = b.encounter.status === "draft" || b.encounter.status === "amending";
  const note = draft ? store.noteFor(id) : chosen ? chosen.note : store.noteFor(id);
  const footer = draft ? "DRAFT — not signed" : chosen ? `Signed by ${chosen.signedBy} on ${fmtDateTime(chosen.signedAt)} · version ${chosen.version}${chosen.reason ? " · amendment: " + chosen.reason : ""}` : "";
  const canExport = store.can("export");
  return h(
    "div",
    { class: "screen" },
    h("div", { class: "no-print" }, h("h1", null, "Consultation note"), draft ? h("p", { class: "badc" }, "Draft preview — sign the consultation to lock it.") : null, versions.length > 1 ? field("Version", select(versions.map((v) => ({ value: String(v.version), label: `v${v.version} · ${v.kind} · ${fmtDateTime(v.signedAt)}` })), String(chosen.version), (v) => app.go("note", { id, version: v }, { replace: true }))) : null),
    h("div", { class: "card print-area" }, noteDom(note), h("p", { class: "small muted" }, footer)),
    h(
      "div",
      { class: "row-btns wrap no-print" },
      h("button", { class: "btn", onclick: () => app.go("encounter", { id }) }, draft ? "Back to editing" : "Open consultation"),
      canExport ? h("button", { class: "btn", onclick: () => { store.logClinical("print", "note", id, b.encounter.patientId); window.print(); } }, "🖶 Print") : null,
      canExport ? h("button", { class: "btn", onclick: async () => {
        if (!(await confirmDialog("Export note", "The exported file contains patient health information in readable form. Store or share it carefully.", { ok: "Export" }))) return;
        await store.logClinical("export", "note", id, b.encounter.patientId);
        const fname = `note-${b.encounter.patientId}-${b.encounter.date}${chosen && !draft ? "-v" + chosen.version : "-draft"}`;
        downloadFile(fname + ".html", noteHtml(note, footer), "text/html;charset=utf-8");
      } }, "⬇ Export (HTML)") : null,
      canExport ? h("button", { class: "btn", onclick: async () => { await store.logClinical("export", "note-text", id, b.encounter.patientId); await navigator.clipboard?.writeText(noteToText(note) + "\n\n" + footer); toast("Copied as text"); } }, "Copy text") : null,
    ),
  );
}
