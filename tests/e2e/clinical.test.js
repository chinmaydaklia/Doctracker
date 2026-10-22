// Browser test: clinical workflow and role restriction, at phone size.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { serve } from "../../scripts/serve.js";

const PORT = 8766;
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

test("doctor documents a consultation; receptionist sees billing but no clinical content", async () => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://localhost:${PORT}/`);
  await page.click("text=Start with example locations");
  await page.click("#nav button[data-tab=more]");
  await page.click("text=Set up clinical records & sign-in");
  await page.fill(".card:has-text('Your doctor account') .field:has-text('Your name') input", "Dr Test");
  await page.fill("input[placeholder^='Password (min']", "clinic pass 2026");
  await page.fill("input[placeholder='Repeat password']", "clinic pass 2026");
  await page.check(".check input");
  await page.click("text=Create account & enable clinical records");
  await page.waitForSelector("text=Your recovery code", { timeout: 30000 });
  const code = (await page.textContent("p.code")).trim();
  await page.fill("input[placeholder^='Type the last group']", code.slice(-4));
  await page.click("text=I have written it down");

  await page.click("text=+ Register patient");
  await page.fill(".field:has-text('Name') >> nth=0 >> input", "Sunita Verma");
  await page.click(".seg button >> text='Female'");
  await page.fill(".field:has-text('Age (years)') input", "47");
  await page.click(".actions >> text=Register");
  await page.click("text=+ New consultation");
  await page.click("button.pill:has-text('Own clinic')");
  await page.click("text=Start consultation");
  await page.click(".chip-btn:has-text('+ Headache')");
  await page.fill(".complaint .field:has-text('Duration') input", "2 weeks");
  await page.fill("input[placeholder=sys]", "200");
  await page.fill("input[placeholder=dia]", "210");
  await page.click("text=Save readings");
  await page.waitForSelector("text=Systolic must be higher");
  await page.fill("input[placeholder=dia]", "110");
  await page.click("text=Save readings");
  await page.waitForSelector("td:has-text('200/110 mmHg')");
  await page.click("text=+ Add diagnosis");
  await page.fill(".modal .field:has-text('Diagnosis') input", "Hypertensive urgency");
  await page.click(".modal .seg button >> text='Suspected'");
  await page.click(".modal .btn.primary");
  await page.waitForSelector(".row:has-text('Hypertensive urgency')");
  await page.click(".actions >> text=Sign & finish");
  await page.click(".modal .btn.primary");
  await page.waitForSelector("h1:has-text('Consultation note')");
  const note = await page.textContent(".print-area");
  assert.match(note, /Headache × 2 weeks/);
  assert.match(note, /200\/110/);
  assert.match(note, /Hypertensive urgency \(Suspected\)/);
  assert.doesNotMatch(note, /Examination/);

  // Doctor adds a receptionist.
  await page.click("#nav button[data-tab=more]");
  await page.click("text=Security & users");
  await page.click("text=+ Add account");
  await page.fill(".modal .field:has-text('Name') >> nth=0 >> input", "Desk");
  await page.fill(".modal .field:has-text('Login name') input", "desk");
  await page.fill(".modal input[type=password]", "front desk 22");
  await page.click(".modal .btn.primary");
  await page.waitForSelector(".row:has-text('Desk')");
  await page.click("button.lockbtn");

  await page.click("button.pill:has-text('Desk')");
  await page.fill("input[type=password]", "front desk 22");
  await page.click("button.btn.primary:has-text('Sign in')");
  await page.waitForSelector("#nav button[data-tab=patients]");
  assert.equal(await page.$("#nav button[data-tab=reports]"), null, "no income reports for reception");
  await page.click("#nav button[data-tab=patients]");
  await page.click("main > .screen > div > button.row:has-text('Sunita Verma')");
  const text = await page.textContent("main");
  assert.match(text, /visible to the treating doctor only/);
  assert.doesNotMatch(text, /Headache|Hypertensive|200\/110/);
  assert.equal(await page.$("text=+ New consultation"), null);
  assert.ok(await page.$("text=+ Visit / fee only"));
  assert.deepEqual(errors, []);
  await ctx.close();
});
