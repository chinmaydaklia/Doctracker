// Browser end-to-end tests (Chromium via playwright-core). Run: npm run test:e2e
// Set CHROMIUM_PATH if Chromium is not at the default location.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { chromium } from "playwright-core";
import { serve } from "../../scripts/serve.js";

const PORT = 8765;
const URL = `http://localhost:${PORT}/`;
let server, ctx, errors;

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const dir = existsSync(base) && readdirSync(base).find((d) => /^chromium-\d+$/.test(d));
  return dir ? join(base, dir, "chrome-linux", "chrome") : undefined;
}

before(async () => {
  server = await serve(PORT);
  const profile = mkdtempSync(join(tmpdir(), "doctracker-e2e-"));
  ctx = await chromium.launchPersistentContext(profile, { executablePath: chromiumPath(), viewport: { width: 400, height: 860 }, acceptDownloads: true });
  errors = [];
  ctx.on("page", (p) => watch(p));
});
after(async () => {
  await ctx?.close();
  server?.close();
});

function watch(page) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
}

async function open() {
  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL);
  return page;
}

test("14. offline entries persist after the app is closed and reopened, even with no network", async () => {
  let page = await open();
  await page.waitForSelector("text=Welcome to Doctracker");
  await page.click("text=Start with example locations");
  await page.click(".quick >> text=Quick session summary");
  await page.click("button.pill:has-text('Village OPD 1')");
  const plus = page.locator(".stepper .step[aria-label=plus]");
  for (let i = 0; i < 3; i++) await plus.nth(0).click();
  await page.click("text=All cash");
  await page.click(".actions >> text=Save");
  await page.waitForSelector("text=Village OPD 1");
  // let the service worker finish caching the shell
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(500);
  await page.close();

  await ctx.setOffline(true);
  page = await open();
  await page.waitForSelector("text=Today");
  assert.match(await page.textContent("main"), /₹450/, "3 × ₹150 still there");
  // Make an entry while offline, close, reopen.
  await page.click(".quick >> text=Individual patient entry");
  await page.click("button.pill:has-text('Own clinic')");
  await page.click("text=Save & close");
  await page.waitForSelector("text=Individual visits (1)");
  await page.close();
  page = await open();
  await page.waitForSelector("text=Today");
  const text = await page.textContent("main");
  assert.ok(text.includes("Today44 new"), "4 patients today");
  await ctx.setOffline(false);
  await page.close();
});

test("demo mode is separate, loads sample data and every screen renders without errors", async () => {
  const page = await open();
  await page.click("#nav button[data-tab=more]");
  await page.click("text=Open demo mode");
  await page.waitForSelector(".demo-banner");
  await page.click("text=Load sample data");
  await page.waitForSelector(".card.warn:has-text('needs reconciliation')", { timeout: 60000 });
  for (const tab of ["sessions", "money", "reports", "more", "home"]) {
    await page.click(`#nav button[data-tab=${tab}]`);
    await page.waitForTimeout(150);
  }
  await page.click(".card.warn:has-text('needs reconciliation')");
  await page.click("button.row >> nth=0");
  await page.waitForSelector("text=Reconciliation");
  await page.fill("textarea", "One slip missing");
  await page.click("text=Keep summary figures");
  await page.waitForSelector("text=Reconciled by");
  await page.click("#nav button[data-tab=money]");
  await page.click(".seg >> text=Hospitals");
  await page.click("button.row:has-text('Hospital A')");
  await page.waitForSelector("text=Settlement periods");
  await page.click("text=Payable");
  await page.waitForSelector("text=Total payable to me");
  await page.click("#nav button[data-tab=reports]");
  for (const r of ["monthly", "location", "payment", "settlement", "recon", "daily"]) {
    await page.selectOption(".filters select >> nth=0", r);
    await page.waitForTimeout(100);
  }
  await page.click("#nav button[data-tab=more]");
  await page.click("text=Locations & fees");
  await page.click("button.row >> nth=0");
  await page.waitForSelector("text=Fee history");
  await page.click("#nav button[data-tab=more]");
  await page.click("text=Audit log");
  await page.waitForSelector("text=Latest");
  await page.click("#nav button[data-tab=more]");
  await page.click("text=Back to my records");
  await page.waitForSelector("text=Today");
  assert.equal(await page.$(".demo-banner"), null);
  assert.doesNotMatch(await page.textContent("main"), /needs reconciliation/, "demo data did not leak into real records");
  assert.deepEqual(errors, []);
  await page.close();
});

test("13. backup downloads, verifies and restores", async () => {
  const page = await open();
  await page.click("#nav button[data-tab=more]");
  await page.click("text=Backup & restore");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("text=Back up now")]);
  const path = await dl.path();
  const backup = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(backup.app, "doctracker");
  assert.ok(backup.stores.visits.length >= 1);
  await page.waitForSelector("text=Backup created and verified");
  await page.setInputFiles(".card:has-text('Verify a backup file') input[type=file]", path);
  await page.waitForSelector("text=complete and intact");
  await page.setInputFiles(".card:has-text('Restore from backup') input[type=file]", path);
  await page.click("text=Replace and restore");
  await page.waitForSelector("text=Today");
  assert.match(await page.textContent("main"), /₹450|₹850/);
  assert.deepEqual(errors, []);
  await page.close();
});
