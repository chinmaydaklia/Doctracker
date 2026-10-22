// Sign-in, first-time clinical setup, users & roles, recovery.
import { h, add, clear, field, select, toast, modal, confirmDialog, attempt, badge } from "./dom.js";
import { ROLES } from "../model.js";
import { fmtDateTime } from "../dates.js";
import { activeUsers, signIn, setupFirstDoctor, addUser, resetPassword, setUserActive, changeOwnPassword, recoverWithCode, newRecovery, MIN_PASSWORD } from "../auth.js";

const pw = (placeholder = "Password") => h("input", { type: "password", autocomplete: "current-password", placeholder });

export function renderLogin(app) {
  const store = app.store;
  const users = activeUsers(store);
  let chosen = users.length === 1 ? users[0] : null;
  const box = h("div");
  const draw = () => {
    clear(box);
    add(box, h("div", { class: "pills" }, users.map((u) => h("button", { type: "button", class: "pill" + (chosen && chosen.id === u.id ? " on" : ""), onclick: () => { chosen = u; draw(); } }, u.name, h("small", { class: "muted" }, " · " + ROLES[u.role])))));
    if (!chosen) return;
    const p = pw();
    const err = h("div", { class: "err" });
    const go = async () => {
      err.textContent = "";
      const btn = box.querySelector(".btn.primary");
      btn.disabled = true;
      try {
        await signIn(store, chosen.id, p.value);
        app.lastActivity = Date.now();
        app.render();
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    };
    p.addEventListener("keydown", (e) => e.key === "Enter" && go());
    add(box, field("Password for " + chosen.name, p), err, h("div", { class: "row-btns" }, h("button", { class: "btn primary big", onclick: go }, "Sign in")), chosen.role === "doctor" ? h("button", { class: "link small", onclick: () => recoveryDialog(app, chosen) }, "Forgot password? Use the recovery code") : null);
    setTimeout(() => p.focus(), 30);
  };
  draw();
  return h("div", { class: "screen narrow" }, h("h1", null, "Sign in"), h("p", { class: "muted small" }, "Doctracker is locked. Records are stored only on this device."), box);
}

function recoveryDialog(app, user) {
  const code = h("input", { type: "text", autocomplete: "off", placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" });
  const p1 = pw("New password");
  const p2 = pw("Repeat new password");
  const err = h("div", { class: "err" });
  return modal("Reset password with recovery code", [h("p", { class: "small" }, "Enter the recovery code you wrote down when clinical records were set up."), field("Recovery code", code), field("New password", p1), field("Repeat", p2), err], [
    { label: "Cancel", result: false },
    {
      label: "Reset & sign in",
      kind: "primary",
      value: async () => {
        if (p1.value !== p2.value) return (err.textContent = "Passwords do not match."), undefined;
        try {
          await recoverWithCode(app.store, user.id, code.value, p1.value);
          toast("Password reset ✓");
          app.render();
          return true;
        } catch (e) {
          err.textContent = e.message;
          return undefined;
        }
      },
    },
  ]);
}

// First doctor account. Explains device-only storage before anything is created.
export function renderSecuritySetup(app) {
  const store = app.store;
  if (store.authEnabled) return renderUsers(app);
  const name = h("input", { type: "text", value: store.settings.userName && store.settings.userName !== "Doctor" ? store.settings.userName : "", placeholder: "Dr ..." });
  const p1 = pw("Password (min " + MIN_PASSWORD + " characters)");
  const p2 = pw("Repeat password");
  const ack = h("input", { type: "checkbox" });
  const err = h("div", { class: "err" });
  const out = h("div");
  const go = async () => {
    err.textContent = "";
    if (!ack.checked) return (err.textContent = "Please confirm you have read the points above.");
    if (p1.value !== p2.value) return (err.textContent = "Passwords do not match.");
    try {
      const { recoveryCode } = await setupFirstDoctor(store, { name: name.value, password: p1.value });
      clear(out);
      const confirmIn = h("input", { type: "text", placeholder: "Type the last group, e.g. " + recoveryCode.slice(-4) });
      const e2 = h("div", { class: "err" });
      add(
        out,
        h(
          "div",
          { class: "card warn" },
          h("h3", null, "Your recovery code"),
          h("p", { class: "code" }, recoveryCode),
          h("p", { class: "small" }, "Write this on paper and keep it somewhere safe, away from the phone. It is the ONLY way to open the clinical records if the password is forgotten. It is shown only now."),
          field("Confirm: type the last 4 characters", confirmIn),
          e2,
          h("button", { class: "btn primary", onclick: () => { if (confirmIn.value.trim().toUpperCase() !== recoveryCode.slice(-4)) return (e2.textContent = "That does not match."); toast("Clinical records enabled ✓"); app.go("patients"); } }, "I have written it down"),
        ),
      );
      form.classList.add("hide");
    } catch (e) {
      err.textContent = e.message;
    }
  };
  const form = h(
    "div",
    null,
    h(
      "div",
      { class: "card" },
      h("h3", null, "Before you start"),
      h(
        "ul",
        { class: "small" },
        h("li", null, h("b", null, "Clinical records are sensitive health data."), " They are encrypted on this device with a key that only doctor accounts (and staff you allow to record vitals/reports) can unlock."),
        h("li", null, h("b", null, "Data lives only on this device."), " It is not synchronised. If the phone is lost, broken or reset, or the browser's site data is cleared, everything on it is gone — except what is in your backups."),
        h("li", null, "Back up regularly and keep the backup file off the phone (Google Drive, email to yourself, a computer). Backups stay encrypted."),
        h("li", null, "After this, everyone signs in. The app locks itself after inactivity. Receptionists can register patients and handle billing but cannot read clinical notes."),
        h("li", null, "If you forget the password, only the recovery code (shown next) can open the clinical records."),
      ),
      h("label", { class: "check" }, ack, " I understand these points"),
    ),
    h("div", { class: "card" }, h("h3", null, "Your doctor account"), field("Your name (shown on consultation notes)", name), field("Password", p1), field("Repeat password", p2), err, h("button", { class: "btn primary big", onclick: go }, "Create account & enable clinical records")),
  );
  return h("div", { class: "screen" }, h("h1", null, "Set up clinical records"), form, out);
}

export function renderUsers(app) {
  const store = app.store;
  if (!store.authEnabled) return renderSecuritySetup(app);
  const me = store.session;
  const users = [...store.data.users].sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active === false ? 1 : -1));
  const lockSel = select([5, 10, 15, 30].map((m) => ({ value: String(m), label: m + " minutes" })), String(store.settings.lockMinutes || 10), (v) => attempt(() => store.saveSettings({ lockMinutes: Number(v) })).then(() => toast("Saved ✓")));
  const views = [...store.data.clinicalAudit].sort((a, b) => b.at - a.at).slice(0, 150);
  return h(
    "div",
    { class: "screen" },
    h("h1", null, "Security & users"),
    h("div", { class: "card" }, h("div", { class: "kv" }, h("span", null, "Signed in as"), h("b", null, me ? `${me.name} (${ROLES[me.role]})` : "—")), h("div", { class: "row-btns wrap" }, h("button", { class: "btn small", onclick: () => passwordDialog(app) }, "Change my password"), h("button", { class: "btn small", onclick: () => app.lock("Signed out.") }, "Sign out")), field("Lock automatically after", lockSel)),
    store.perms.includes("users")
      ? [
          h(
            "div",
            { class: "card" },
            h("h3", null, "Accounts"),
            h("p", { class: "small muted" }, "Doctor: everything. Receptionist: patient registration, visits and billing — no clinical notes (cannot decrypt them). Staff/nurse: patient registration; optionally vitals and reports for consultations."),
            users.map((u) =>
              h(
                "div",
                { class: "row" + (u.active === false ? " dim" : "") },
                h("div", { class: "grow" }, h("b", null, u.name), h("div", { class: "small muted" }, ROLES[u.role], u.role === "staff" ? (u.canClinical ? " · vitals & reports" : " · registration only") : "", " · ", u.username, u.active === false ? " · inactive" : "")),
                h("div", { class: "right" }, h("button", { class: "link small", onclick: () => resetDialog(app, u) }, "Reset password"), me && me.userId !== u.id ? h("button", { class: "link small", onclick: async () => { if (await confirmDialog(u.active === false ? "Activate account" : "Deactivate account", u.name)) attempt(() => setUserActive(store, u.id, u.active === false)).then(() => app.render()); } }, u.active === false ? "Activate" : "Deactivate") : null),
              ),
            ),
            h("button", { class: "btn primary small", onclick: () => userDialog(app) }, "+ Add account"),
          ),
          h("div", { class: "card" }, h("h3", null, "Recovery code"), h("p", { class: "small" }, "Make a new recovery code if the old one may have been seen. The old code stops working."), h("button", { class: "btn small", onclick: async () => {
            if (!(await confirmDialog("New recovery code", "Replace the recovery code? Write the new one down immediately."))) return;
            const code = await attempt(() => newRecovery(store));
            if (code) modal("New recovery code", [h("p", { class: "code" }, code), h("p", { class: "small" }, "Write it down now. It will not be shown again.")], [{ label: "Done", result: true }]);
          } }, "Make new recovery code")),
        ]
      : null,
    store.perms.includes("users")
      ? h("div", { class: "card" }, h("h3", null, "Clinical access log"), h("p", { class: "small muted" }, "Sign-ins and who opened, changed, printed or exported which record (no clinical content)."), views.map((a) => h("div", { class: "small row" }, h("span", { class: "grow" }, fmtDateTime(a.at), " · ", a.user, " · ", h("b", null, a.action), " ", a.entity), h("span", { class: "muted" }, a.patientId || ""))))
      : null,
  );
}

function userDialog(app) {
  let role = "receptionist";
  const name = h("input", { type: "text" });
  const uname = h("input", { type: "text", autocomplete: "off", placeholder: "short login name" });
  const p1 = pw("Temporary password");
  const clin = h("input", { type: "checkbox" });
  const clinBox = h("label", { class: "check hide" }, clin, " Can record vitals and attach reports (holds the clinical key; other clinical content is hidden by the app)");
  const err = h("div", { class: "err" });
  return modal("Add account", [field("Name", name), field("Login name", uname), field("Role", select(Object.entries(ROLES).map(([value, label]) => ({ value, label })), role, (v) => { role = v; clinBox.classList.toggle("hide", v !== "staff"); })), clinBox, field("Password", p1), err], [
    { label: "Cancel", result: false },
    {
      label: "Add",
      kind: "primary",
      value: () =>
        addUser(app.store, { name: name.value, username: uname.value, role, password: p1.value, canClinical: clin.checked })
          .then(() => { toast("Account added ✓"); app.render(); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; }),
    },
  ]);
}

function resetDialog(app, u) {
  const p1 = pw("New password");
  const err = h("div", { class: "err" });
  return modal("Reset password: " + u.name, [field("New password", p1), err], [
    { label: "Cancel", result: false },
    { label: "Reset", kind: "primary", value: () => resetPassword(app.store, u.id, p1.value).then(() => { toast("Password reset ✓"); return true; }).catch((e) => { err.textContent = e.message; return undefined; }) },
  ]);
}

function passwordDialog(app) {
  const o = pw("Current password");
  const p1 = pw("New password");
  const p2 = pw("Repeat new password");
  const err = h("div", { class: "err" });
  return modal("Change my password", [field("Current", o), field("New", p1), field("Repeat", p2), err], [
    { label: "Cancel", result: false },
    {
      label: "Change",
      kind: "primary",
      value: () => {
        if (p1.value !== p2.value) return (err.textContent = "Passwords do not match."), undefined;
        return changeOwnPassword(app.store, o.value, p1.value).then(() => { toast("Password changed ✓"); return true; }).catch((e) => { err.textContent = e.message; return undefined; });
      },
    },
  ]);
}

export { badge };
