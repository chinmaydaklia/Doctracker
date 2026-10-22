// Prescription scanner UI: capture → clean up → read (AI or manual) → patient → review → import.
import { h, add, clear, date, field, dateInput, segmented, select, toast, modal, confirmDialog, askReason, attempt, badge } from "./dom.js";
import { today, fmtDateTime } from "../dates.js";
import { SEXES, CERTAINTY, DIAGNOSIS_KINDS, CONDITION_STATUS, ALLOWED_UPLOADS, MAX_UPLOAD_BYTES } from "../model.js";
import { ageLabel } from "../clinical.js";
import { sniffType } from "../clinical-store.js";
import { isUncertain, scanFlags, CRITICAL_MED_KEYS } from "../ocr/schema.js";
import { PROVIDER_LABEL } from "../ocr/claude.js";
import { parseWrittenDate } from "../scan-store.js";
import { fileLink, openFile } from "./patients.js";

// ------------------------------------------------------------ step 1-4

export function renderScan(app, params) {
  const store = app.store;
  const st = { file: null, bitmap: null, ops: { rotation: 0, fine: 0, quad: null, brightness: 0, contrast: 20, grayscale: true, threshold: false }, enhanced: null, result: null, provider: null, patientId: params.patientId || null, encounterId: params.encounterId || null };
  const root = h("div", { class: "screen" });
  const body = h("div");
  const patient = st.patientId && store.get("patients", st.patientId);
  add(root, h("h1", null, "Scan prescription"), patient ? h("p", { class: "small" }, "For ", h("b", null, patient.name), " · ", ageLabel(patient), " · ", patient.id) : null, body);

  const stepCapture = () => {
    clear(body);
    const pick = (capture) => {
      const inp = h("input", { type: "file", class: "hide", accept: capture ? "image/*" : "image/jpeg,image/png,image/webp,application/pdf,.pdf", capture: capture ? "environment" : null });
      inp.addEventListener("change", async () => {
        const f = inp.files[0];
        if (!f) return;
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (bytes.length > MAX_UPLOAD_BYTES) return toast("File is larger than 15 MB. Use a smaller photo.", "err");
        const mime = sniffType(bytes);
        if (!mime || !ALLOWED_UPLOADS[mime]) return toast("Only JPEG, PNG, WebP or PDF files.", "err");
        st.file = { bytes, mime, name: f.name };
        if (mime === "application/pdf") stepRead();
        else {
          const { loadBitmap } = await import("../ocr/preprocess.js");
          try {
            st.bitmap = await loadBitmap(bytes, mime);
          } catch {
            return toast("This image could not be opened.", "err");
          }
          stepEnhance();
        }
      });
      return inp;
    };
    const cam = pick(true);
    const up = pick(false);
    add(
      body,
      h("div", { class: "card" }, h("p", null, "Photograph the prescription flat, in good light, with the whole page in view. Avoid shadows and glare."), h("div", { class: "quick" }, h("button", { class: "btn primary big", onclick: () => cam.click() }, "📷 Take photo"), h("button", { class: "btn big", onclick: () => up.click() }, "⬆ Upload image or PDF")), cam, up),
      h("p", { class: "small muted" }, "The original is kept as an encrypted attachment of the patient's record. Nothing is saved until you choose the patient."),
    );
  };

  // ---- clean-up editor: rotation, 4 corners (crop + perspective), contrast
  const stepEnhance = async () => {
    const P = await import("../ocr/preprocess.js");
    const G = await import("../ocr/geometry.js");
    clear(body);
    const stage = h("div", { class: "crop-stage" });
    const detectNote = h("p", { class: "small muted" });
    let autoTried = false;
    const autoDetect = (canvas) => {
      const { detectPage } = G;
      const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const q = detectPage(img);
      detectNote.textContent = q ? "Page edges detected automatically — drag the corners if they are not right." : "Could not find the page edges automatically — drag the corners to the paper's edges.";
      return q;
    };
    const preview = h("div", { class: "enh-preview" });
    let base, scale, corners;
    const draw = () => {
      clear(stage);
      base = P.rotatedCanvas(st.bitmap, st.ops.rotation, st.ops.fine);
      const W = Math.min(stage.clientWidth || 360, 900);
      scale = W / base.width;
      const view = h("canvas", { class: "crop-canvas", width: Math.round(base.width * scale), height: Math.round(base.height * scale) });
      view.getContext("2d").drawImage(base, 0, 0, view.width, view.height);
      if (!st.ops.quad && !autoTried) {
        autoTried = true;
        st.ops.quad = autoDetect(base);
      }
      if (!st.ops.quad) {
        const m = 0.02;
        st.ops.quad = [{ x: base.width * m, y: base.height * m }, { x: base.width * (1 - m), y: base.height * m }, { x: base.width * (1 - m), y: base.height * (1 - m) }, { x: base.width * m, y: base.height * (1 - m) }];
      }
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "crop-svg");
      svg.setAttribute("viewBox", `0 0 ${view.width} ${view.height}`);
      const poly = document.createElementNS(NS, "polygon");
      poly.setAttribute("class", "crop-poly");
      svg.append(poly);
      const wrap = h("div", { class: "crop-wrap", style: { width: view.width + "px", height: view.height + "px" } }, view, svg);
      const sync = () => poly.setAttribute("points", st.ops.quad.map((p) => `${p.x * scale},${p.y * scale}`).join(" "));
      corners = st.ops.quad.map((p, i) => {
        const hd = h("div", { class: "crop-handle", role: "slider", "aria-label": ["top left", "top right", "bottom right", "bottom left"][i] + " corner", tabindex: "0" });
        const place = () => Object.assign(hd.style, { left: p.x * scale + "px", top: p.y * scale + "px" });
        place();
        hd.addEventListener("pointerdown", (ev) => {
          hd.setPointerCapture(ev.pointerId);
          const rect = wrap.getBoundingClientRect();
          const move = (e) => {
            p.x = Math.max(0, Math.min(base.width - 1, (e.clientX - rect.left) / scale));
            p.y = Math.max(0, Math.min(base.height - 1, (e.clientY - rect.top) / scale));
            place();
            sync();
          };
          const up = () => {
            hd.removeEventListener("pointermove", move);
            hd.removeEventListener("pointerup", up);
          };
          hd.addEventListener("pointermove", move);
          hd.addEventListener("pointerup", up);
          ev.preventDefault();
        });
        hd.addEventListener("keydown", (e) => {
          const d = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] }[e.key];
          if (!d) return;
          p.x = Math.max(0, Math.min(base.width - 1, p.x + d[0] / scale));
          p.y = Math.max(0, Math.min(base.height - 1, p.y + d[1] / scale));
          place();
          sync();
          e.preventDefault();
        });
        wrap.append(hd);
        return hd;
      });
      sync();
      add(stage, wrap);
    };
    const rot = (d) => {
      st.ops.rotation = (st.ops.rotation + d + 360) % 360;
      st.ops.quad = null;
      autoTried = false;
      draw();
    };
    const slider = (label, key, min, max) => {
      const out = h("span", { class: "small muted" }, String(st.ops[key]));
      const s = h("input", { type: "range", min, max, value: st.ops[key], oninput: (e) => { st.ops[key] = Number(e.target.value); out.textContent = e.target.value; if (key === "fine") { st.ops.quad = null; draw(); } } });
      return h("label", { class: "range" }, label, " ", out, s);
    };
    const doPreview = async () => {
      clear(preview).append(h("p", { class: "muted small" }, "Processing…"));
      try {
        st.enhanced = await P.renderEnhanced(st.bitmap, st.ops);
        clear(preview);
        add(preview, h("p", { class: "small" }, "Cleaned-up copy (sent for reading; the original is kept too):"), h("img", { class: "preview", alt: "enhanced prescription", src: URL.createObjectURL(new Blob([st.enhanced.bytes], { type: "image/jpeg" })) }));
      } catch (e) {
        clear(preview).append(h("p", { class: "err" }, e.message));
      }
    };
    add(
      body,
      h("p", { class: "small muted" }, "Drag the four corners to the edges of the prescription. This crops it and straightens a tilted photo."),
      detectNote,
      stage,
      h(
        "div",
        { class: "card" },
        h("div", { class: "row-btns wrap" }, h("button", { class: "btn small", onclick: () => rot(-90) }, "⟲ Rotate left"), h("button", { class: "btn small", onclick: () => rot(90) }, "⟳ Rotate right"), h("button", { class: "btn small", onclick: () => { st.ops.quad = null; autoTried = true; detectNote.textContent = ""; draw(); } }, "Reset corners"), h("button", { class: "btn small", onclick: () => { st.ops.quad = autoDetect(P.rotatedCanvas(st.bitmap, st.ops.rotation, st.ops.fine)); autoTried = true; draw(); } }, "Detect page edges")),
        slider("Straighten (°)", "fine", -15, 15),
        slider("Brightness", "brightness", -60, 60),
        slider("Contrast", "contrast", -40, 80),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.ops.grayscale, onchange: (e) => (st.ops.grayscale = e.target.checked) }), " Greyscale"),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.ops.threshold, onchange: (e) => (st.ops.threshold = e.target.checked) }), " Sharpen ink (for shadows / faint pen)"),
        h("div", { class: "row-btns wrap" }, h("button", { class: "btn", onclick: doPreview }, "Preview clean-up")),
      ),
      preview,
      h("div", { class: "actions sticky" }, h("button", { class: "btn", onclick: stepCapture }, "Retake"), h("button", { class: "btn primary big", onclick: async () => { if (!st.enhanced) await doPreview(); if (st.enhanced) stepRead(); } }, "Use this image")),
    );
    requestAnimationFrame(draw);
  };

  // ---- reading: AI (cloud, opt-in) or manual
  const stepRead = () => {
    clear(body);
    const cfg = store.ocrSettings;
    const cloudOk = cfg.enabled && (cfg.apiKey || cfg.baseURL);
    const status = h("div");
    const readAI = async () => {
      if (!(await confirmDialog("Send image for reading?", `Only this image is sent to ${PROVIDER_LABEL} over an encrypted connection. Nothing from the patient's record is sent. Anthropic processes it under its API terms; this app does not upload it to file storage.\n\nYou will check every field before anything is saved.`, { ok: "Send and read" }))) return;
      clear(status).append(h("div", { class: "card" }, h("b", null, "Reading the handwriting…"), h("p", { class: "small muted" }, "This can take up to a minute.")));
      try {
        const { createClient, readPrescription } = await import("../ocr/claude.js");
        const client = await createClient({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
        const img = st.enhanced || st.file;
        st.result = await readPrescription({ client, bytes: img.bytes, mime: img.mime || st.file.mime });
        st.provider = "claude";
        await store.logClinical("cloud-read", "scan", "pending", st.patientId);
        const fl = scanFlags(st.result.extraction);
        if (fl.some((f) => f.code === "unreadable" || f.code === "not_medical")) {
          clear(status).append(h("div", { class: "card warn" }, fl.map((f) => h("p", null, f.text)), h("div", { class: "row-btns wrap" }, h("button", { class: "btn", onclick: stepCapture }, "Retake photo"), h("button", { class: "btn", onclick: () => { st.result = null; st.provider = "manual"; stepPatient(); } }, "Enter manually"), h("button", { class: "btn", onclick: stepPatient }, "Review anyway"))));
          return;
        }
        stepPatient();
      } catch (e) {
        clear(status).append(h("div", { class: "card bad" }, h("p", null, e.message), h("div", { class: "row-btns wrap" }, h("button", { class: "btn", onclick: readAI }, "Try again"), h("button", { class: "btn", onclick: () => { st.provider = "manual"; stepPatient(); } }, "Enter manually"))));
      }
    };
    add(
      body,
      h(
        "div",
        { class: "card" },
        h("h3", null, "How should it be read?"),
        cloudOk
          ? h("button", { class: "choice", onclick: readAI }, h("b", null, "Read handwriting with AI (cloud)"), h("span", null, `${PROVIDER_LABEL}. The image leaves this device; you review every field.`))
          : h("p", { class: "small muted" }, "AI reading is off. A doctor can enable it in More → Clinical note & templates → Prescription reading."),
        h("button", { class: "choice", onclick: () => { st.provider = "manual"; stepPatient(); } }, h("b", null, "Type it myself"), h("span", null, "No cloud. The image is shown beside the form.")),
      ),
      status,
    );
  };

  // ---- patient: confirm or choose; register if new
  const stepPatient = () => {
    clear(body);
    const exP = st.result && st.result.extraction.patient;
    const written = exP ? [exP.name.text, exP.age.text, exP.sex.text].filter(Boolean).join(" · ") : "";
    const save = async (patientId) => {
      const sc = await attempt(() => store.createScan({ patientId, encounterId: st.encounterId, original: { bytes: st.file.bytes, name: st.file.name }, enhanced: st.enhanced ? { bytes: st.enhanced.bytes } : null, provider: st.provider || "manual", result: st.result, preprocess: st.enhanced ? { ...st.ops, quad: st.ops.quad } : null }));
      if (sc) app.go("scanReview", { id: sc.id }, { replace: true });
    };
    if (st.patientId) {
      const p = store.get("patients", st.patientId);
      add(body, h("div", { class: "card" }, h("p", null, "Saving to ", h("b", null, p.name), " · ", ageLabel(p), " · ", p.id), written ? h("p", { class: "small" }, "Written on the prescription: ", h("b", null, written)) : h("p", { class: "small muted" }, "No patient details read from the prescription."), h("p", { class: "small muted" }, "If the details differ you will be asked to confirm before anything is imported."), h("button", { class: "btn primary big", onclick: () => save(p.id) }, "Continue to review")));
      return;
    }
    const age = exP && Number(String(exP.age.text || "").match(/\d+/)?.[0]);
    const matches = exP && exP.name.text ? store.patientMatches({ name: exP.name.text, ageYears: Number.isFinite(age) ? age : undefined, mobile: exP.mobile.text || "" }) : [];
    const q = h("input", { type: "search", placeholder: "Search patient", value: exP?.name.text || "" });
    const res = h("div");
    const run = async () => {
      const { searchPatients } = await import("../clinical.js");
      clear(res);
      for (const x of searchPatients(store.data.patients, q.value).slice(0, 8)) add(res, h("button", { class: "row click", onclick: () => save(x.id) }, h("div", null, h("b", null, x.name), h("div", { class: "small muted" }, ageLabel(x), " · ", x.id))));
    };
    q.addEventListener("input", run);
    run();
    add(
      body,
      h("div", { class: "card" }, h("h3", null, "Whose prescription is this?"), written ? h("p", null, "Written on it: ", h("b", null, written)) : h("p", { class: "small muted" }, "No patient details could be read."), h("p", { class: "small muted" }, "The patient is never chosen automatically.")),
      matches.length ? h("div", { class: "card" }, h("h3", null, "Possible matches"), matches.map((m) => h("button", { class: "row click", onclick: () => save(m.patient.id) }, h("div", null, h("b", null, m.patient.name), h("div", { class: "small muted" }, ageLabel(m.patient), " · ", m.patient.id)), h("div", { class: "right small" }, m.reasons.join(", "))))) : null,
      h("div", { class: "card" }, field("Find patient", q), res),
      h("button", { class: "btn", onclick: () => quickRegister(app, exP).then((pid) => pid && save(pid)) }, "+ Register new patient"),
    );
  };

  stepCapture();
  return root;
}

async function quickRegister(app, exP) {
  const name = h("input", { type: "text", value: exP?.name.text || "" });
  const age = h("input", { type: "number", value: Number(String(exP?.age.text || "").match(/\d+/)?.[0]) || "" });
  let sex = /^m/i.test(exP?.sex.text || "") ? "male" : /^f/i.test(exP?.sex.text || "") ? "female" : "unknown";
  const err = h("div", { class: "err" });
  return modal("Register patient", [field("Name", name), field("Age (years)", age), field("Sex", segmented(Object.entries(SEXES).map(([value, label]) => ({ value, label })), sex, (v) => (sex = v))), h("p", { class: "small muted" }, "Check the spelling against the image."), err], [
    { label: "Cancel", result: null },
    {
      label: "Register",
      kind: "primary",
      value: async () => {
        try {
          let r = await app.store.registerPatient({ name: name.value, ageYears: age.value, sex });
          if (r.needsConfirm) {
            const ok = await confirmDialog("Possible existing patient", r.matches.map((m) => `${m.patient.name} · ${ageLabel(m.patient)} · ${m.patient.id} (${m.reasons.join(", ")})`).join("\n") + "\n\nRegister a separate new patient anyway?", { ok: "Register new" });
            if (!ok) return undefined;
            r = await app.store.registerPatient({ name: name.value, ageYears: age.value, sex }, { confirmNew: true });
          }
          return r.patient.id;
        } catch (e) {
          err.textContent = e.message;
          return undefined;
        }
      },
    },
  ]);
}

// ----------------------------------------------------------------- review

const SECTIONS = [
  ["document", "Prescription details"],
  ["patient", "Patient (for identification only — never changes the record)"],
  ["complaints", "Chief complaints"],
  ["comorbidities", "Comorbidities"],
  ["vitals", "Vitals"],
  ["examination", "Examination"],
  ["diagnoses", "Diagnosis"],
  ["investigations", "Investigations"],
  ["medications", "Medicines (saved as unverified history, not a prescription)"],
  ["advice", "Advice"],
  ["followup", "Follow-up"],
];
const STATUS_BADGE = { pending: ["To review", "warn"], approved: ["Approved", "ok"], rejected: ["Rejected", "mid"], imported: ["In record", "ok"] };
const legLabel = { clear: "clear", unclear: "unclear", illegible: "illegible" };

export function renderScanReview(app, { id }) {
  const store = app.store;
  const s = store.get("scans", id);
  if (!s) return h("div", { class: "screen" }, "Scan not found.");
  store.logClinical("view", "scan", id, s.patientId);
  const p = store.get("patients", s.patientId);
  const closed = s.status === "rejected";
  const rerender = () => app.go("scanReview", { id }, { replace: true });
  const imgBox = h("div", { class: "scan-image" }, h("p", { class: "muted small" }, "Loading image…"));
  (async () => {
    const fid = s.enhancedFileId || s.originalFileId;
    const f = await attempt(() => store.readFile(fid));
    if (!f) return;
    clear(imgBox);
    const url = URL.createObjectURL(new Blob([f.bytes], { type: f.mime }));
    if (f.mime === "application/pdf") add(imgBox, h("button", { class: "btn", onclick: () => window.open(url, "_blank", "noopener") }, "Open PDF beside this window"));
    else add(imgBox, h("img", { src: url, alt: "scanned prescription", class: "scan-img", onclick: () => openFile(app, fid) }));
    add(imgBox, h("div", { class: "small muted" }, s.enhancedFileId ? h("button", { class: "link small", onclick: () => openFile(app, s.originalFileId) }, "View original") : null, " · tap image to enlarge"));
  })();

  const act = (fieldId, payload) => attempt(() => store.reviewScanField(id, fieldId, payload).then(() => true)).then((ok) => ok && rerender());

  const fieldRow = (f) => {
    const [sl, sk] = STATUS_BADGE[f.status] || [f.status, ""];
    const locked = f.status === "imported" || closed;
    const uncertain = isUncertain(f);
    const mustType = f.section === "medications" && CRITICAL_MED_KEYS.includes(f.key) && (uncertain || f.flags.some((x) => x.code === "missing")) && !f.edited;
    const input = h("input", { type: "text", value: f.value || "", disabled: locked, placeholder: f.extracted && f.extracted.legibility === "illegible" ? "Illegible — type what you read, or reject" : "", lang: "hi-IN" });
    input.addEventListener("change", () => input.value.trim() !== (f.value || "") && act(f.id, { action: "edit", value: input.value }));
    const checked = h("input", { type: "checkbox" });
    const extras = [];
    if (f.section === "diagnoses") {
      extras.push(h("div", { class: "grid2" }, field("Type", select(Object.entries(DIAGNOSIS_KINDS).map(([value, label]) => ({ value, label })), f.meta.kind, (v) => act(f.id, { action: "meta", meta: { kind: v } }), { disabled: locked || null })), field("Certainty", select(Object.entries(CERTAINTY).filter(([k]) => k !== "confirmed" || !uncertain || f.edited).map(([value, label]) => ({ value, label })), f.meta.certainty, (v) => act(f.id, { action: "meta", meta: { certainty: v } }), { disabled: locked || null }))));
      if (uncertain && !f.edited) extras.push(h("p", { class: "small muted" }, "“Confirmed” is not available for an uncertain reading."));
    }
    if (f.section === "examination") extras.push(field("As written", segmented([{ value: "normal", label: "Normal" }, { value: "abnormal", label: "Abnormal" }], f.meta.status, (v) => act(f.id, { action: "meta", meta: { status: v } }))));
    if (f.section === "comorbidities") extras.push(field("Status", select([{ value: "", label: f.meta.writtenAs === "known_case" ? "Current (known case)" : "Uncertain" }, ...Object.entries(CONDITION_STATUS).map(([value, label]) => ({ value, label }))], f.meta.condStatus || "", (v) => v && act(f.id, { action: "meta", meta: { condStatus: v } }), { disabled: locked || null })));
    if (f.section === "medications" && f.key === "name" && f.meta.catalogue && f.meta.catalogue.suggestions.length && !locked)
      extras.push(h("div", { class: "small" }, "Use a catalogue spelling only if that is what is written: ", f.meta.catalogue.suggestions.map((n) => h("button", { class: "link small", onclick: () => act(f.id, { action: "edit", value: n }) }, n))));
    return h(
      "div",
      { class: "scan-field" + (uncertain ? " uncertain" : "") + (f.status === "rejected" ? " dim" : "") },
      h("div", { class: "sf-head" }, h("b", null, f.label), " ", badge(sl, sk), f.edited ? badge("typed by doctor", "mid") : null),
      f.extracted ? h("div", { class: "small" }, "Read as: ", h("q", null, f.extracted.text ?? "—"), h("span", { class: "muted" }, ` · ${legLabel[f.extracted.legibility]} · ${Math.round(f.extracted.confidence * 100)}%`)) : h("div", { class: "small muted" }, f.flags.some((x) => x.code === "missing") ? "Not written on the prescription" : "Added manually"),
      f.flags.map((x) => h("div", { class: "flag-line" }, "⚠ ", x.text)),
      f.hints.map((x) => h("div", { class: "small muted" }, "ⓘ ", x)),
      input,
      extras,
      locked
        ? f.importedTo ? h("div", { class: "small okc" }, "Imported ✓") : null
        : h(
            "div",
            { class: "row-btns wrap" },
            mustType ? h("span", { class: "small badc" }, "Type the value you read (the reading is uncertain)") : uncertain && !f.edited ? h("label", { class: "check small" }, checked, " I checked this against the image") : null,
            h("button", { class: "btn small primary", disabled: mustType || null, onclick: () => act(f.id, { action: "approve", verified: checked.checked }) }, "✓ Approve"),
            f.status !== "rejected" ? h("button", { class: "btn small", onclick: () => act(f.id, { action: "reject" }) }, "✗ Reject") : h("button", { class: "btn small", onclick: () => act(f.id, { action: "reset" }) }, "Undo"),
          ),
      f.history.length ? h("details", { class: "small muted" }, h("summary", null, `History (${f.history.length})`), f.history.map((x) => h("div", null, fmtDateTime(x.at), " · ", x.by, " · ", x.action, x.to !== undefined && typeof x.to === "string" ? ` → “${x.to}”` : ""))) : null,
    );
  };

  const addField = async (section) => {
    const n = s.fields.filter((f) => f.section === section).length;
    const defs = {
      complaints: [["complaint", "Complaint"], ["duration", "Duration"]],
      comorbidities: [["condition", "Comorbidity"]],
      vitals: [["value", "Vital (e.g. BP 140/90)"]],
      examination: [["finding", "Examination finding"]],
      diagnoses: [["diagnosis", "Diagnosis"]],
      investigations: [["name", "Investigation"], ["result", "Result (if written)"]],
      medications: [["name", "name"], ["strength", "strength"], ["dose", "dose"], ["frequency", "frequency"], ["duration", "duration"]],
      advice: [["advice", "Advice"]],
      followup: [["interval", "Follow-up interval"]],
    }[section];
    const g = { complaints: "cc", comorbidities: "cm", vitals: "vt", examination: "ex", diagnoses: "dx", investigations: "in", medications: "md", advice: "ad", followup: "fu" }[section] + "m" + Date.now().toString(36);
    let vt = "bp";
    let sys = "general";
    const inputs = defs.map(([k, l]) => [k, l, h("input", { type: "text", lang: "hi-IN" })]);
    const ok = await modal("Add " + section, [section === "vitals" ? field("Type", select(["bp", "pulse", "rr", "temp", "spo2", "weight", "height", "glucose", "other"].map((v) => ({ value: v, label: v.toUpperCase() })), vt, (v) => (vt = v))) : null, section === "examination" ? field("System", select(["general", "cvs", "rs", "abdomen", "cns", "msk", "skin", "other"].map((v) => ({ value: v, label: v })), sys, (v) => (sys = v))) : null, inputs.map(([, l, i]) => field(l, i))], [{ label: "Cancel", result: false }, { label: "Add", kind: "primary", result: true }]);
    if (!ok) return;
    for (const [k, l, i] of inputs) {
      if (!i.value.trim()) continue;
      const meta = section === "vitals" ? { vitalType: vt } : section === "examination" ? { system: sys, status: null } : section === "diagnoses" ? { kind: n ? "secondary" : "primary", certainty: "provisional" } : section === "investigations" ? { kind: "advised" } : {};
      const label = section === "medications" ? `Medicine (added) — ${l}` : l;
      await attempt(() => store.addScanField(id, { section, group: g, key: k, label, value: i.value, meta }));
    }
    rerender();
  };

  const approveClear = async () => {
    const clearOnes = s.fields.filter((f) => f.status === "pending" && !isUncertain(f) && !f.flags.some((x) => x.code === "missing") && clean(f.value) && (f.section !== "examination" || f.meta.status));
    if (!clearOnes.length) return toast("No clearly read fields left to approve.");
    if (!(await confirmDialog("Approve clearly read fields", `Approve ${clearOnes.length} fields that were read clearly with high confidence? Check them against the image first. Uncertain fields still need your individual attention.`, { ok: "Approve " + clearOnes.length })))
      return;
    for (const f of clearOnes) await attempt(() => store.reviewScanField(id, f.id, { action: "approve" }));
    rerender();
  };

  const pc = s.patientCheck;
  const counts = { pending: 0, approved: 0, rejected: 0, imported: 0 };
  for (const f of s.fields) counts[f.status] = (counts[f.status] || 0) + 1;

  const sections = SECTIONS.map(([key, title]) => {
    const fs = s.fields.filter((f) => f.section === key);
    if (!fs.length && (key === "document" || key === "patient")) return null;
    const groups = [...new Set(fs.map((f) => f.group))];
    return h("details", { class: "card sec-card", open: fs.some((f) => f.status === "pending") || !fs.length ? true : null }, h("summary", null, h("h3", null, title, h("small", { class: "muted" }, ` (${fs.length})`))), groups.map((g) => h("div", { class: key === "medications" ? "scan-group" : "" }, fs.filter((f) => f.group === g).map(fieldRow))), !closed && key !== "document" && key !== "patient" ? h("button", { class: "btn small", onclick: () => addField(key) }, "+ Add " + (key === "medications" ? "medicine" : "item")) : null);
  });

  return h(
    "div",
    { class: "screen wide" },
    h("h1", null, "Review scanned prescription"),
    h("p", { class: "small" }, h("button", { class: "link", onclick: () => app.go("patient", { id: p.id }) }, p.name), ` · ${ageLabel(p)} · ${p.id} · `, s.provider === "claude" ? `read by ${s.model}` : "manual entry", " · ", fmtDateTime(s.createdAt), " · ", badge(s.status.replace("_", " "), s.status === "imported" ? "ok" : s.status === "rejected" ? "mid" : "warn")),
    s.flags.length ? h("div", { class: "card warn" }, s.flags.map((f) => h("p", { class: "small" }, "⚠ ", f.text))) : null,
    h(
      "div",
      { class: "card " + (pc.result === "match" ? "" : pc.confirmedAt ? "" : "warn") },
      h("b", null, pc.result === "match" ? "Patient details on the prescription match the record" : pc.result === "mismatch" ? "⚠ Patient details differ from the selected patient" : "Patient not named on the prescription"),
      pc.reasons.map((r) => h("div", { class: "small" }, r)),
      pc.result !== "match" ? (pc.confirmedAt ? h("p", { class: "small okc" }, `Confirmed by ${pc.confirmedBy} · ${fmtDateTime(pc.confirmedAt)}`) : h("div", { class: "row-btns wrap" }, h("button", { class: "btn small primary", onclick: () => attempt(() => store.confirmScanPatient(id)).then(rerender) }, `Yes, this is ${p.name}'s prescription`), h("button", { class: "btn small", onclick: () => rejectFlow(app, id) }, "Wrong patient — reject"))) : null,
    ),
    h(
      "div",
      { class: "scan-review" },
      h("div", { class: "scan-left" }, imgBox),
      h(
        "div",
        { class: "scan-right" },
        h("div", { class: "small muted" }, `${counts.pending || 0} to review · ${counts.approved || 0} approved · ${counts.rejected || 0} rejected · ${counts.imported || 0} in record`),
        !closed ? h("div", { class: "row-btns wrap" }, h("button", { class: "btn small", onclick: approveClear }, "Approve all clearly read fields…")) : null,
        sections,
        !closed && store.can("clinical.sign") ? importPanel(app, s) : null,
        !closed && !s.fields.some((f) => f.status === "imported") ? h("button", { class: "btn danger-o small", onclick: () => rejectFlow(app, id) }, "Reject this scan") : null,
        closed ? h("p", { class: "badc" }, "Rejected: ", s.rejectReason) : null,
        h("details", { class: "small muted card" }, h("summary", null, "Scan history"), s.history.map((x) => h("div", null, fmtDateTime(x.at), " · ", x.by, " · ", x.action, x.detail ? " — " + x.detail : "")), s.importLog.map((l) => h("div", null, fmtDateTime(l.at), " · imported into ", h("button", { class: "link small", onclick: () => app.go("encounter", { id: l.encounterId }) }, "consultation"), ` (${l.created.length} records)`))),
      ),
    ),
  );
}

const clean = (v) => String(v || "").trim();

async function rejectFlow(app, id) {
  const r = await askReason("Reject scan", "The image and reading are kept for the record, but nothing will be imported.", { ok: "Reject", danger: true, placeholder: "e.g. wrong patient, unreadable, duplicate" });
  if (r !== null && (await attempt(() => app.store.rejectScan(id, r).then(() => true)))) app.render();
}

function importPanel(app, s) {
  const store = app.store;
  const approved = s.fields.filter((f) => f.status === "approved");
  const enc = s.encounterId && store.get("encounters", s.encounterId);
  const editable = enc && (enc.status === "draft" || enc.status === "amending");
  const docField = approved.find((f) => f.section === "document" && f.key === "date");
  const st = { mode: editable ? "encounter" : "new", locationId: store.settings.lastLocationId || store.locationsSorted()[0]?.id, date: (docField && parseWrittenDate(docField.value)) || today() };
  const box = h("div");
  const draw = () => {
    clear(box);
    add(
      box,
      editable ? field("Import into", segmented([{ value: "encounter", label: "This consultation (" + date(enc.date) + ")" }, { value: "new", label: "A new paper-prescription record" }], st.mode, (v) => { st.mode = v; draw(); })) : null,
      st.mode === "new" ? [h("div", { class: "grid2" }, field("Prescription date", dateInput(st.date, (v) => (st.date = v))), field("location", select(store.locationsSorted().map((l) => ({ value: l.id, label: l.name })), st.locationId, (v) => (st.locationId = v)))), h("p", { class: "small muted" }, "Creates a draft consultation of type “Paper prescription (scanned)”, with no fee. Review and sign it afterwards.")] : null,
    );
  };
  draw();
  const go = async () => {
    const meds = approved.filter((f) => f.section === "medications" && f.key === "name").length;
    const ok = await confirmDialog("Import approved information", `${approved.length} approved fields will be added to ${store.get("patients", s.patientId).name}'s record.${meds ? `\n\n${meds} medicine(s) will be saved as UNVERIFIED medicine history — not as a prescription, and not as an instruction to dispense.` : ""}\n\nExisting notes and prescriptions are not changed; text is only added. Pending fields are not imported.`, { ok: "Import" });
    if (!ok) return;
    const r = await attempt(() => store.importScan(s.id, st.mode === "encounter" ? { mode: "encounter", encounterId: enc.id } : { mode: "new", locationId: st.locationId, date: st.date }));
    if (r) {
      toast(`Imported ✓ (${r.created.length} records)`);
      app.go("encounter", { id: r.encounterId });
    }
  };
  return h("div", { class: "card ok" }, h("h3", null, "Import into the record"), h("p", { class: "small" }, `${approved.length} approved field${approved.length === 1 ? "" : "s"} ready. Only approved fields are imported.`), box, h("button", { class: "btn primary big", disabled: !approved.length || null, onclick: go }, "Import approved fields"));
}

export function scanCard(app, sc) {
  const store = app.store;
  const counts = (sc.fields || []).reduce((t, f) => ((t[f.status] = (t[f.status] || 0) + 1), t), {});
  return h("button", { class: "card tl click", onclick: () => app.go("scanReview", { id: sc.id }) }, h("div", { class: "small muted" }, date(new Date(sc.createdAt).toISOString().slice(0, 10)), " · Scanned prescription · ", sc.provider === "claude" ? "AI-read" : "manual", " ", badge((sc.status || "").replace("_", " "), sc.status === "imported" ? "ok" : sc.status === "rejected" ? "mid" : "warn")), h("div", { class: "small" }, `${counts.imported || 0} in record · ${counts.approved || 0} approved · ${counts.pending || 0} to review`), store.get("files", sc.originalFileId) ? fileLink(app, store.get("files", sc.originalFileId)) : null);
}
