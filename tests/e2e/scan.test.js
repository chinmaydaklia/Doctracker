// Browser test: scan → AI read (Anthropic endpoint intercepted) → review → import.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { serve } from "../../scripts/serve.js";
import { feverRx } from "../fixtures/prescriptions.js";

const PORT = 8767;
let server, browser;
function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const dir = existsSync(base) && readdirSync(base).find((d) => /^chromium-\d+$/.test(d));
  return dir ? join(base, dir, "chrome-linux", "chrome") : undefined;
}
before(async () => {
  server = await serve(PORT);
  browser = await chromium.launch({ executablePath: chromiumPath() });
});
after(async () => {
  await browser?.close();
  server?.close();
});

// Set SHOTS=/some/dir to save screenshots of the main steps.
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }) : null);
const FIELD = (title) => `.scan-field:has(.sf-head b:text-is("${title}"))`;

test("scan a prescription, review against the image, and import safely", async () => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  let captured = null;
  await page.route("https://api.anthropic.com/**", async (route) => {
    const r = route.request();
    captured = { url: r.url(), headers: r.headers(), body: JSON.parse(r.postData()) };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "request-id": "req_test", "access-control-allow-origin": "*" },
      body: JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify(feverRx) }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 1500, output_tokens: 900 } }),
    });
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.click("text=Start with example locations");
  await page.click("#nav button[data-tab=more]");
  await page.click("text=Set up clinical records & sign-in");
  await page.fill(".card:has-text('Your doctor account') .field:has-text('Your name') input", "Dr Scan");
  await page.fill("input[placeholder^='Password (min']", "clinic pass 2026");
  await page.fill("input[placeholder='Repeat password']", "clinic pass 2026");
  await page.check(".check input");
  await page.click("text=Create account & enable clinical records");
  await page.waitForSelector("text=Your recovery code", { timeout: 30000 });
  await page.fill("input[placeholder^='Type the last group']", (await page.textContent("p.code")).trim().slice(-4));
  await page.click("text=I have written it down");

  // Enable cloud reading (disclosure must be accepted).
  await page.click("#nav button[data-tab=more]");
  await page.click("text=Clinical note & templates");
  await page.fill("input[placeholder='sk-ant-…']", "sk-ant-test-key");
  await page.click("button:has-text('Enable cloud reading')");
  await page.waitForSelector(".err:has-text('Read and accept')");
  await page.check("label:has-text('I have read these points') input");
  await page.click("button:has-text('Enable cloud reading')");
  await page.waitForSelector("h3:has-text('Prescription reading') .badge:has-text('on')");

  // Patient
  await page.click("#nav button[data-tab=patients]");
  await page.click("text=+ Register patient");
  await page.fill(".field:has-text('Name') >> nth=0 >> input", "Ramesh Kumar");
  await page.click(".seg button >> text='Male'");
  await page.fill(".field:has-text('Age (years)') input", "54");
  await page.click(".actions >> text=Register");
  await page.click("text=📷 Scan prescription");

  // Upload an image, clean it up, read with AI.
  await page.setInputFiles("input[type=file]:not([capture])", "icons/icon-512.png");
  await page.waitForSelector(".crop-handle");
  await shot(page, "scan-1-crop");
  await page.click("text=Use this image");
  await page.waitForSelector("text=How should it be read?", { timeout: 20000 });
  await page.click("text=Read handwriting with AI (cloud)");
  await page.click(".modal .btn.primary"); // disclosure: Send and read
  await page.waitForSelector("text=Continue to review", { timeout: 20000 });
  assert.ok(captured, "request reached the Anthropic endpoint through the vendored SDK");
  // SDK 1.x sends the API key as a bearer credential.
  assert.ok(captured.headers["authorization"] === "Bearer sk-ant-test-key" || captured.headers["x-api-key"] === "sk-ant-test-key");
  assert.match(captured.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.match(captured.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(captured.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(captured.body.model, "claude-opus-5-5");
  assert.equal(captured.body.output_config.format.type, "json_schema");
  assert.equal(captured.body.messages[0].content[0].source.media_type, "image/jpeg", "the cleaned-up JPEG is sent");
  assert.ok(!JSON.stringify(captured.body).includes("Ramesh"), "no patient data from the record is sent");
  await page.click("text=Continue to review");
  await page.waitForSelector("h1:has-text('Review scanned prescription')");
  assert.ok(await page.isVisible(".scan-img"), "original beside the fields");
  await shot(page, "scan-2-review");
  if (process.env.SHOTS) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SHOTS}/scan-3-review-desktop.png` });
    await page.setViewportSize({ width: 412, height: 900 });
  }

  // The uncertain drug name cannot be approved until typed.
  const az = page.locator(`${FIELD("Medicine 2 — name")}`);
  assert.ok(await az.locator("button:has-text('Approve')").isDisabled());
  assert.match(await az.textContent(), /Similar names: Azithral/);
  await az.locator("input[type=text]").fill("Tab Azithral 500");
  await az.locator("input[type=text]").press("Tab");
  await page.waitForSelector(`${FIELD("Medicine 2 — name")} .badge:has-text('typed by doctor')`);
  await page.click(`${FIELD("Medicine 2 — name")} button:has-text('Approve')`);
  await page.waitForSelector(`${FIELD("Medicine 2 — name")} .badge:has-text('Approved')`, { state: "attached" });

  // Bulk-approve only the clearly read fields; then fix °F before import.
  await page.click("text=Approve all clearly read fields…");
  await page.click(".modal .btn.primary");
  await page.waitForSelector(`${FIELD("Temp")} .badge:has-text('Approved')`, { state: "attached" });
  assert.ok(await page.isVisible(`${FIELD("Medicine 3 — frequency")} .badge:has-text('To review')`), "uncertain fields are not bulk-approved");
  await page.click("text=Import approved fields");
  await page.click(".modal .btn.primary");
  await page.waitForSelector("#toast:has-text('°F')");
  await page.click("details.sec-card:has(h3:has-text('Vitals')) > summary");
  const temp = page.locator(`${FIELD("Temp")}`);
  await temp.locator("input[type=text]").fill("38.3 °C");
  await temp.locator("input[type=text]").press("Tab");
  await page.waitForSelector(`${FIELD("Temp")} .badge:has-text('typed by doctor')`);
  await page.click(`${FIELD("Temp")} button:has-text('Approve')`);
  await page.waitForSelector(`${FIELD("Temp")} .badge:has-text('Approved')`, { state: "attached" });
  // Medicine 3: its name is unreviewed but its dose was approved -> import must refuse.
  await page.click("text=Import approved fields");
  await page.click(".modal .btn.primary");
  await page.waitForSelector("#toast:has-text('Medicine 3: approve its name')");
  await page.click(`${FIELD("Medicine 3 — dose")} button:has-text('Reject')`);
  await page.waitForSelector(`${FIELD("Medicine 3 — dose")} .badge:has-text('Rejected')`, { state: "attached" });
  await page.waitForSelector(`${FIELD("Temp")} .badge:has-text('Approved')`, { state: "attached" });
  await page.click("text=Import approved fields");
  await page.click(".modal .btn.primary");
  await page.waitForFunction(() => location.hash === "#encounter", null, { timeout: 15000 });
  const enc = await page.textContent("main");
  assert.match(enc, /Paper prescription \(scanned\)/);
  assert.doesNotMatch(enc, /Approved prescription/, "no prescription generated");

  // Medicines tab: imported as unverified history.
  await page.click(".patient-head h1 button");
  await page.click(".seg.tabs button:has-text('Medicines')");
  const meds = await page.textContent("main");
  assert.match(meds, /Tab Dolo 650/);
  assert.match(meds, /Tab Azithral 500/);
  assert.match(meds, /not verified/);
  await page.click(".seg.tabs button:has-text('Timeline')");
  assert.match(await page.textContent("main"), /Scanned prescription/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
