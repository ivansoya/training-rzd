/** Проба редизайна: «Наборы» и страница набора глазами браузера (только чтение, скриншоты в test-results). */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const CODE = process.env.CODE || "XVW8MA6NGJ3A5RKRMRH5";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(BASE + "/");
console.log("вход:", await page.evaluate(async () => (await fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
})).status));

await page.goto(`${BASE}/projects/${CODE}/training`);
await page.waitForSelector(".ts-row", { timeout: 20000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/s-list.png`, fullPage: true });
console.log("строк:", await page.locator(".ts-row").count());

await page.locator(".ts-row .ui-btn-ghost").first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/s-menu.png` });
await page.keyboard.press("Escape");

const name = process.env.SET || "qa-aug G1 граф";
await page.locator(".ts-row", { hasText: name }).first().click();
await page.waitForSelector(".ts-pass", { timeout: 20000 });
await page.waitForSelector(".ts-grid .fr-tile", { timeout: 20000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/s-page.png`, fullPage: true });
await page.locator(".ts-recipe").scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/s-page-bottom.png` });
await page.locator(".ts-pass section").last().scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.locator(".ts-pass").screenshot({ path: `${OUT}/s-passport.png` });

const copy = page.getByRole("button", { name: /^Копии графа/ });
if (await copy.count()) {
  await copy.click();
  await page.waitForTimeout(1200);
  await page.locator(".ts-gal").screenshot({ path: `${OUT}/s-copies.png` });
}
await page.locator(".ts-grid .fr-tile").first().click();
await page.waitForSelector(".ts-lbx", { timeout: 10000 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/s-lightbox.png` });
await page.getByRole("button", { name: "Исходный кадр" }).click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/s-lightbox-orig.png` });
await page.keyboard.press("Escape");

await page.goto(`${BASE}/projects/${CODE}/training`);
await page.waitForSelector(".ts-row", { timeout: 20000 });
const bad = page.locator(".ts-row", { hasText: "Не собрался" });
if (await bad.count()) {
  await bad.first().click();
  await page.waitForSelector(".ts-pass", { timeout: 20000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/s-page-error.png`, fullPage: true });
}

console.log("ошибки:", errors.length ? errors : "нет");
await browser.close();
