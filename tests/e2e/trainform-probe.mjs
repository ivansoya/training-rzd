/** Форма запуска обучения — глазами браузера.
 *
 * Открывает набор проекта, жмёт «Обучить», снимает форму и печатает то, что
 * должно быть на экране по умолчанию: patience 30, аугментации YOLO включены,
 * модель предобученная, тонкая настройка свёрнута. Считаем, а не смотрим.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://frontend";
const PROJECT = process.env.PROJECT || "8Q3C658DWU9H68HGQMY6";
const OUT = "test-results/trainform";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
page.on("pageerror", (e) => console.log("ОШИБКА СТРАНИЦЫ:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("КОНСОЛЬ:", m.text());
});

await page.goto(BASE + "/");
const code = await page.evaluate(async () => {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "123456" }),
  });
  return r.status;
});
console.log("вход:", code);

await page.goto(`${BASE}/projects/${PROJECT}/training?tab=sets`);
await page.waitForSelector(".t-rows", { timeout: 20000 });
const btn = page.locator(".t-row button.mag-btn", { hasText: "Учить" }).first();
console.log("кнопка запуска:", (await btn.textContent())?.trim());
await btn.click();
await page.waitForSelector(".mag-modal.t-modal-wide", { timeout: 15000 });
// Дождаться, пока форма получит спецификацию с сервера.
await page.waitForFunction(
  () => document.querySelector("#run-patience")?.value !== "",
  null,
  { timeout: 15000 }
);
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/01-form.png`, fullPage: true });

const got = await page.evaluate(() => {
  const v = (id) => document.querySelector(id)?.value ?? null;
  const c = (id) => document.querySelector(id)?.checked ?? null;
  const modelSel = document.querySelector("#run-model");
  return {
    models: [...modelSel.options].map((o) => o.textContent.trim()),
    modelValue: modelSel.value,
    note: document.querySelector(".t-form-note")?.textContent.trim(),
    scratch: c("#run-scratch"),
    epochs: v("#run-epochs"),
    imgsz: v("#run-imgsz"),
    batch: v("#run-batch"),
    patience: v("#run-patience"),
    augOn: c("#run-aug-on"),
    mosaic: v("#run-mosaic"),
    fliplr: v("#run-fliplr"),
    scale: v("#run-scale"),
    close_mosaic: v("#run-close_mosaic"),
    augFields: document.querySelectorAll(".t-form-section .t-form-grid input[type=number]").length,
    foldOpen: document.querySelector("details.t-fold")?.open,
    sections: [...document.querySelectorAll(".t-form-section .g-label")].map((e) => e.textContent.trim()),
  };
});
console.log(JSON.stringify(got, null, 2));

// Тонкая настройка: раскрыть и снять.
await page.click("details.t-fold > summary");
await page.waitForTimeout(200);
const fine = await page.evaluate(() => {
  const v = (id) => document.querySelector(id)?.value ?? null;
  return {
    optimizer: v("#run-optimizer"),
    lr0: v("#run-lr0"),
    warmup: v("#run-warmup_epochs"),
    freeze: v("#run-freeze"),
    workers: v("#run-workers"),
    workersPlaceholder: document.querySelector("#run-workers")?.placeholder,
    fields: document.querySelectorAll("details.t-fold input, details.t-fold select").length,
  };
});
console.log(JSON.stringify(fine, null, 2));
await page.screenshot({ path: `${OUT}/02-form-fine.png`, fullPage: true });

// Выключить аугментации — сетка должна исчезнуть, подсказка появиться.
await page.click("#run-aug-on");
await page.waitForTimeout(200);
const off = await page.evaluate(() => ({
  augFieldsLeft: document.querySelectorAll("#run-mosaic").length,
  hint: document.querySelector("#run-aug-on")?.closest(".t-form-section")?.querySelector(".t-form-hint")?.textContent.trim().slice(0, 60),
}));
console.log(JSON.stringify(off));
await page.screenshot({ path: `${OUT}/03-form-aug-off.png`, fullPage: true });

await browser.close();
