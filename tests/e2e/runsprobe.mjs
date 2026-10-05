/** Проба редизайна: «Прогоны» и страница прогона глазами браузера (только чтение, скриншоты в test-results). */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const CODE = process.env.CODE || "8CMYC2KSGXL5DAGAGRXE";
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

await page.goto(`${BASE}/projects/${CODE}/runs`);
await page.waitForSelector(".rn-row", { timeout: 20000 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/r-history.png`, fullPage: true });
console.log("строк:", await page.locator(".rn-row").count());

await page.getByRole("button", { name: /^Прерванные/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/r-history-broken.png` });
await page.getByRole("button", { name: /^Все/ }).first().click();

const n = process.env.RUN || await page.locator(".rn-row b.mono").first().innerText().then((t) => t.replace("№", ""));
await page.goto(`${BASE}/projects/${CODE}/runs/${n}`);
await page.waitForSelector(".rn-head", { timeout: 20000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/r-run.png`, fullPage: true });

const cm = page.locator(".ui-card", { hasText: "Матрица ошибок" });
if (await cm.count()) {
  await cm.getByRole("button", { name: "Путаницы" }).click();
  await page.waitForTimeout(300);
  await cm.screenshot({ path: `${OUT}/r-pairs.png` });
}
const cls = page.locator(".ui-card", { hasText: "AP50 по классам" });
if (await cls.count()) {
  await cls.getByRole("button", { name: "Таблица" }).click();
  await page.waitForTimeout(300);
  await cls.screenshot({ path: `${OUT}/r-classes-table.png` });
}

await page.getByRole("button", { name: "Ещё" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/r-menu.png` });
await page.keyboard.press("Escape");

await page.getByRole("button", { name: "Новое обучение" }).click();
await page.waitForSelector(".rn-form", { timeout: 10000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/r-dialog.png` });
await page.keyboard.press("Escape");

console.log("ошибки:", errors.length ? errors : "нет");
await browser.close();
