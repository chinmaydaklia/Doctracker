// Local accounts and roles. Passwords never leave the device and are never stored:
// only a PBKDF2 verifier. Clinical users also hold a wrapped copy of the data key.

import { ROLES } from "./model.js";
import { newId } from "./ids.js";
import { makeCredential, checkCredential, newDataKey, wrapKey, unwrapKey, newRecoveryCode, normalizeRecoveryCode, DEFAULT_ITERATIONS } from "./crypto.js";
import { ValidationError, PermissionError } from "./store.js";

const req = (c, m) => {
  if (!c) throw new ValidationError(m);
};

export const MIN_PASSWORD = 8;

function checkPassword(pw) {
  req(typeof pw === "string" && pw.length >= MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters.`);
  req(!/^(.)\1+$/.test(pw) && !/^(12345678|password|qwertyui)/i.test(pw), "Choose a less guessable password.");
}

const holdsKey = (u) => u.role === "doctor" || (u.role === "staff" && u.canClinical);

export function activeUsers(store) {
  return store.data.users.filter((u) => u.active !== false).sort((a, b) => a.name.localeCompare(b.name));
}

function keysMeta(store) {
  return store.get("meta", "keys");
}

// First doctor account: creates the clinical data key and the recovery code.
// The recovery code is returned once and never stored in readable form.
export async function setupFirstDoctor(store, { name, username, password, iterations = DEFAULT_ITERATIONS }) {
  req(!store.authEnabled, "Accounts are already set up.");
  req(String(name || "").trim(), "Enter your name.");
  checkPassword(password);
  const dek = await newDataKey();
  const cred = await makeCredential(password, iterations);
  const recoveryCode = newRecoveryCode();
  const rcred = await makeCredential(normalizeRecoveryCode(recoveryCode), iterations);
  const now = store.clock();
  const user = {
    id: newId("U"),
    name: String(name).trim(),
    username: String(username || name).trim().toLowerCase(),
    role: "doctor",
    canClinical: true,
    cred: { salt: cred.salt, iterations: cred.iterations, verifier: cred.verifier },
    wrappedDek: await wrapKey(dek, cred.kek),
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  const keys = { id: "keys", createdAt: now, recovery: { salt: rcred.salt, iterations: rcred.iterations, verifier: rcred.verifier, wrappedDek: await wrapKey(dek, rcred.kek) } };
  await store.commit([{ store: "users", put: user }, { store: "meta", put: keys }], [{ action: "create", entity: "user", entityId: user.id, after: { role: user.role, username: user.username }, reason: "First doctor account; clinical records enabled" }]);
  await store.startSession(user, dek);
  return { user, recoveryCode };
}

const failures = new Map(); // userId -> { count, until }

export async function signIn(store, userId, password) {
  const u = store.data.users.find((x) => x.id === userId && x.active !== false);
  req(u, "Choose your account.");
  const f = failures.get(userId);
  if (f && f.until > Date.now()) throw new PermissionError(`Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} s.`);
  const kek = await checkCredential(String(password || ""), u.cred);
  if (!kek) {
    const count = (f ? f.count : 0) + 1;
    failures.set(userId, { count, until: count >= 5 ? Date.now() + 30000 * Math.pow(2, Math.min(count - 5, 5)) : 0 });
    await store.logClinical("sign-in-failed", "user", userId);
    throw new PermissionError("Wrong password.");
  }
  failures.delete(userId);
  const dek = u.wrappedDek ? await unwrapKey(u.wrappedDek, kek) : null;
  await store.startSession(u, dek);
  await store.logClinical("sign-in", "user", userId);
  return u;
}

export async function signOut(store) {
  if (store.session) await store.logClinical("sign-out", "user", store.session.userId);
  await store.endSession();
}

export async function addUser(store, { name, username, role, password, canClinical = false }) {
  store.requirePerm("users");
  req(ROLES[role], "Choose a role.");
  req(String(name || "").trim(), "Enter the person's name.");
  const uname = String(username || name).trim().toLowerCase();
  req(!store.data.users.some((u) => u.username === uname && u.active !== false), "That username is taken.");
  checkPassword(password);
  const user = { id: newId("U"), name: String(name).trim(), username: uname, role, canClinical: role === "doctor" || (role === "staff" && !!canClinical), active: true, createdAt: store.clock(), updatedAt: store.clock() };
  const cred = await makeCredential(password, store.data.users[0]?.cred.iterations || DEFAULT_ITERATIONS);
  user.cred = { salt: cred.salt, iterations: cred.iterations, verifier: cred.verifier };
  if (holdsKey(user)) {
    req(store.dek, "Sign in as a doctor to give clinical access.");
    user.wrappedDek = await wrapKey(store.dek, cred.kek);
  } else user.wrappedDek = null;
  await store.commit([{ store: "users", put: user }], [{ action: "create", entity: "user", entityId: user.id, after: { role, username: uname, canClinical: user.canClinical } }]);
  return user;
}

export async function resetPassword(store, userId, password) {
  store.requirePerm("users");
  const u = store.data.users.find((x) => x.id === userId);
  req(u, "Unknown user.");
  checkPassword(password);
  const cred = await makeCredential(password, u.cred.iterations);
  const next = { ...u, cred: { salt: cred.salt, iterations: cred.iterations, verifier: cred.verifier }, updatedAt: store.clock() };
  if (holdsKey(u)) {
    req(store.dek, "Sign in as a doctor first.");
    next.wrappedDek = await wrapKey(store.dek, cred.kek);
  }
  await store.commit([{ store: "users", put: next }], [{ action: "reset-password", entity: "user", entityId: u.id }]);
}

export async function changeOwnPassword(store, oldPassword, newPassword) {
  req(store.session, "Not signed in.");
  const u = store.data.users.find((x) => x.id === store.session.userId);
  const kek = await checkCredential(oldPassword, u.cred);
  req(kek, "Current password is wrong.");
  checkPassword(newPassword);
  const cred = await makeCredential(newPassword, u.cred.iterations);
  const next = { ...u, cred: { salt: cred.salt, iterations: cred.iterations, verifier: cred.verifier }, updatedAt: store.clock() };
  if (u.wrappedDek) next.wrappedDek = await wrapKey(await unwrapKey(u.wrappedDek, kek), cred.kek);
  // A user may always change their own password.
  await store.commit([{ store: "users", put: next }], [{ action: "change-password", entity: "user", entityId: u.id }], { raw: true });
}

export async function setUserActive(store, userId, active) {
  store.requirePerm("users");
  const u = store.data.users.find((x) => x.id === userId);
  req(u, "Unknown user.");
  if (!active && u.role === "doctor") req(activeUsers(store).filter((x) => x.role === "doctor" && x.id !== userId).length > 0, "At least one active doctor account is required.");
  req(!(store.session && store.session.userId === userId && !active), "You cannot deactivate your own account.");
  const next = { ...u, active, updatedAt: store.clock() };
  // A deactivated clinical user loses their wrapped key copy.
  if (!active) next.wrappedDek = null;
  await store.commit([{ store: "users", put: next }], [{ action: active ? "activate" : "deactivate", entity: "user", entityId: u.id }]);
}

// Forgotten doctor password: the recovery code unlocks the data key and sets a new password.
export async function recoverWithCode(store, userId, code, newPassword) {
  const keys = keysMeta(store);
  req(keys && keys.recovery, "No recovery code is set up.");
  const u = store.data.users.find((x) => x.id === userId && x.active !== false);
  req(u && u.role === "doctor", "Recovery is for doctor accounts.");
  checkPassword(newPassword);
  const kek = await checkCredential(normalizeRecoveryCode(code), keys.recovery);
  if (!kek) throw new PermissionError("Recovery code is not correct.");
  const dek = await unwrapKey(keys.recovery.wrappedDek, kek);
  const cred = await makeCredential(newPassword, u.cred.iterations);
  const next = { ...u, cred: { salt: cred.salt, iterations: cred.iterations, verifier: cred.verifier }, wrappedDek: await wrapKey(dek, cred.kek), updatedAt: store.clock() };
  await store.commit([{ store: "users", put: next }], [{ action: "recover", entity: "user", entityId: u.id, reason: "Password reset with recovery code" }], { raw: true });
  await store.startSession(next, dek);
  return next;
}

// Replace the recovery code (e.g. if the old one may have been seen).
export async function newRecovery(store) {
  store.requirePerm("users");
  req(store.dek, "Sign in as a doctor first.");
  const code = newRecoveryCode();
  const iterations = store.data.users[0]?.cred.iterations || DEFAULT_ITERATIONS;
  const rcred = await makeCredential(normalizeRecoveryCode(code), iterations);
  const keys = { ...(keysMeta(store) || { id: "keys", createdAt: store.clock() }), recovery: { salt: rcred.salt, iterations: rcred.iterations, verifier: rcred.verifier, wrappedDek: await wrapKey(store.dek, rcred.kek) }, updatedAt: store.clock() };
  await store.commit([{ store: "meta", put: keys }], [{ action: "new-recovery-code", entity: "keys", entityId: "keys" }]);
  return code;
}
