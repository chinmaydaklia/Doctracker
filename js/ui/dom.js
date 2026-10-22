// Minimal DOM helpers: h() element builder, dialogs, toasts, form controls.
import { fmtINR, toPaise, rupeesInput } from "../money.js";
import { fmtDate } from "../dates.js";
import { L } from "../i18n.js";

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "value") el.value = v; // property, so <textarea> and <select> show it too
      else if (k in el && k !== "list" && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, children);
  return el;
}

// Like Element.append, but skips null/false and flattens arrays (as h() does).
export function add(el, ...children) {
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const money = (p, o) => fmtINR(p, o);
export const date = (d) => fmtDate(d);

let toastTimer;
export function toast(msg, kind = "ok") {
  let t = document.getElementById("toast");
  if (!t) {
    t = h("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.append(t);
  }
  t.textContent = msg;
  t.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), kind === "err" ? 5000 : 2600);
}

// Generic modal. Resolves with whatever `onDone` passes, or null when dismissed.
export function modal(title, body, buttons) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const close = (val) => {
      back.remove();
      if (prev && prev.focus) prev.focus();
      resolve(val);
    };
    const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", null, title), h("div", { class: "modal-body" }, body), h("div", { class: "modal-btns" }, buttons.map((b) => h("button", { class: "btn " + (b.kind || ""), type: "button", onclick: async (ev) => {
      let v = b.value ? b.value() : b.result;
      if (v && typeof v.then === "function") {
        ev.currentTarget.disabled = true;
        const btn = ev.currentTarget;
        try {
          v = await v;
        } finally {
          btn.disabled = false;
        }
      }
      if (v === undefined) return; // validation failed, keep open
      close(v);
    } }, b.label))));
    const back = h("div", { class: "modal-back", onclick: (e) => e.target === back && close(null) }, box);
    back.addEventListener("keydown", (e) => e.key === "Escape" && close(null));
    document.body.append(back);
    const f = box.querySelector("input,textarea,select") || box.querySelector(".btn.primary");
    if (f) f.focus();
  });
}

export function confirmDialog(title, message, { ok = "Confirm", danger = false } = {}) {
  return modal(title, h("p", null, message), [
    { label: "Cancel", result: false },
    { label: ok, kind: danger ? "danger" : "primary", result: true },
  ]);
}

// Ask for a required reason (corrections, voids, reopen...). Returns string or null.
export function askReason(title, message, { ok = "Save", danger = false, required = true, placeholder = "Reason" } = {}) {
  const ta = h("textarea", { rows: 3, placeholder, class: "full" });
  const err = h("div", { class: "err" });
  return modal(title, [message ? h("p", null, message) : null, ta, err], [
    { label: "Cancel", result: null },
    {
      label: ok,
      kind: danger ? "danger" : "primary",
      value: () => {
        const v = ta.value.trim();
        if (required && !v) {
          err.textContent = "A reason is required for the audit log.";
          return undefined;
        }
        return v;
      },
    },
  ]);
}

export function errorToast(e) {
  console.error(e && e.name === "ValidationError" ? e.message : e);
  toast(e && e.message ? e.message : String(e), "err");
}

// Run an async action with error reporting; returns its result or undefined.
export async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    errorToast(e);
    return undefined;
  }
}

// ----------------------------------------------------------------- controls

// A <label> wraps only a single form control. Composite controls (button groups,
// stepper, date + text) go in a <div>: a tap inside a <label> is re-sent by the
// browser to the label's first control, which would reset a button group to its
// first option.
export function field(labelKey, control, hint) {
  const single = control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement;
  return h(single ? "label" : "div", { class: "field", role: single ? null : "group" }, h("span", { class: "lbl" }, typeof labelKey === "string" ? L(labelKey) : labelKey), control, hint ? h("small", { class: "hint" }, hint) : null);
}

export function moneyInput({ value = null, placeholder = "0", oninput, allowNegative = false, id } = {}) {
  const el = h("input", { type: "text", inputmode: "decimal", class: "money", placeholder, value: value === null ? "" : rupeesInput(value), id, autocomplete: "off" });
  el.paise = () => {
    if (el.value.trim() === "") return 0;
    return toPaise(el.value, { allowNegative });
  };
  el.setPaise = (p) => (el.value = p ? rupeesInput(p) : "");
  el.addEventListener("input", () => {
    el.classList.toggle("bad", el.value.trim() !== "" && el.paise() === null);
    oninput && oninput();
  });
  return el;
}

export function dateInput(value, onchange) {
  const shown = h("span", { class: "dmy" }, fmtDate(value));
  const el = h("input", { type: "date", value, required: true });
  el.addEventListener("change", () => {
    shown.textContent = fmtDate(el.value);
    onchange && onchange(el.value);
  });
  const wrap = h("span", { class: "date-wrap" }, el, shown);
  wrap.input = el;
  Object.defineProperty(wrap, "value", { get: () => el.value, set: (v) => { el.value = v; shown.textContent = fmtDate(v); } });
  return wrap;
}

// Whole-number stepper with large − / + buttons.
export function stepper(value, onchange, { min = 0, max = 5000 } = {}) {
  const inp = h("input", { type: "text", inputmode: "numeric", value: String(value || 0), class: "count", "aria-label": "count" });
  const set = (n) => {
    n = Math.max(min, Math.min(max, n));
    inp.value = String(n);
    onchange(n);
  };
  inp.addEventListener("input", () => {
    const n = parseInt(inp.value.replace(/\D/g, ""), 10);
    onchange(Number.isFinite(n) ? Math.min(max, n) : 0);
  });
  inp.addEventListener("focus", () => inp.select());
  const val = () => parseInt(inp.value, 10) || 0;
  return h("span", { class: "stepper" }, h("button", { type: "button", class: "step", "aria-label": "minus", onclick: () => set(val() - 1) }, "−"), inp, h("button", { type: "button", class: "step", "aria-label": "plus", onclick: () => set(val() + 1) }, "+"));
}

// Row of large toggle buttons. options: [{value, label}]
export function segmented(options, value, onchange, { cls = "" } = {}) {
  const wrap = h("div", { class: "seg " + cls, role: "radiogroup" });
  const render = (v) => {
    clear(wrap);
    for (const o of options) {
      wrap.append(h("button", { type: "button", role: "radio", "aria-checked": String(o.value === v), class: o.value === v ? "on" : "", onclick: () => { render(o.value); onchange(o.value); } }, o.label));
    }
  };
  render(value);
  wrap.set = render;
  return wrap;
}

export function select(options, value, onchange, attrs = {}) {
  const el = h("select", attrs, options.map((o) => h("option", { value: o.value, selected: o.value === value }, o.label)));
  el.addEventListener("change", () => onchange && onchange(el.value));
  return el;
}

export function badge(text, kind = "") {
  return h("span", { class: "badge " + kind }, text);
}

export function statRow(label, value, kind = "") {
  return h("div", { class: "kv " + kind }, h("span", null, label), h("b", null, value));
}

export function downloadFile(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}
