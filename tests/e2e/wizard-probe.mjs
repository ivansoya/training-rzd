/** Мастер набора с умным делением и список обучений после удаления набора.
 *
 * Считаем, а не смотрим: строка фона в таблице по классам, подпись
 * «считаю», подпись «набор удалён» у обучений.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://frontend";
const PROJECT = process.env.PROJECT || "8Q3C658DWU9H68HGQMY6";
const OUT = "test-results/wizard";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("pageerror", (e) => console.log("ОШИБКА СТРАНИЦЫ:", e.message));

await page.goto(BASE + "/");
await page.evaluate(async () => {
  await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "123456" }),
  });
});

// --- обучения без набора ---------------------------------------------------
await page.goto(`${BASE}/projects/${PROJECT}/training?tab=runs`);
await page.waitForSelector(".t-rows, .mag-empty-big", { timeout: 20000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/01-runs.png`, fullPage: true });
const runs = await page.$$eval(".t-row", (rows) =>
  rows.slice(0, 3).map((r) => r.textContent.replace(/\s+/g, " ").trim().slice(0, 140))
);
console.log("обучения:", JSON.stringify(runs, null, 1));

await page.goto(`${BASE}/projects/${PROJECT}/training?tab=sets`);
await page.waitForTimeout(800);
const sets = await page.$$eval(".t-row", (rows) => rows.length);
console.log("наборов в списке:", sets);

// --- мастер: умное деление -------------------------------------------------
await page.goto(`${BASE}/projects/${PROJECT}/training/new`);
await page.waitForSelector(".t-wiz", { timeout: 20000 });
await page.waitForFunction(() => document.querySelector(".t-legend b")?.textContent, null, { timeout: 20000 });
// Шаг «Как делить».
const next = page.locator("button.mag-btn", { hasText: "Дальше" });
await next.click();
await page.waitForSelector(".t-choice", { timeout: 10000 });
const choices = await page.$$eval(".t-choice .t", (els) => els.map((e) => e.textContent.trim()));
console.log("стратегии:", choices);
const smartIdx = choices.findIndex((c) => /умн/i.test(c));
await page.locator(".t-choice").nth(smartIdx).click();
// Пока считается — должна быть подпись.
const computing = await page.waitForSelector(".t-computing", { timeout: 5000 }).then((e) => e.textContent()).catch(() => null);
console.log("подпись во время счёта:", computing);
await page.waitForFunction(() => !document.querySelector(".t-computing"), null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/02-wizard-smart.png`, fullPage: true });
const got = await page.evaluate(() => ({
  groups: document.querySelector(".t-kv b")?.textContent,
  kv: [...document.querySelectorAll(".t-side .t-kv")].map((e) => e.textContent.replace(/\s+/g, " ").trim()),
  bgRow: document.querySelector(".t-bg-row")?.textContent.replace(/\s+/g, " ").trim(),
  warnings: [...document.querySelectorAll(".t-warn")].map((e) => e.textContent.trim().slice(0, 80)),
}));
console.log(JSON.stringify(got, null, 1));
await browser.close();
