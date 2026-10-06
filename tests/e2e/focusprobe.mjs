/** Проба редизайна: редактор кадров «Фокус» глазами браузера. Только смотрит — разметку и статусы не трогает. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const OUT = "/work/tests/e2e/test-results";
const PROJECT = process.env.PROJECT || "РСМ-2000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(BASE + "/");
console.log("вход:", await page.evaluate(async () => (await fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
})).status));

// Таска с кадрами и кадр с разметкой — на нём видно объекты
const at = await page.evaluate(async ([name, want]) => {
  const r = await (await fetch("/api/projects")).json();
  const code = (r.projects.find((p) => p.name === name) || r.projects[0]).code;
  const tasks = await (await fetch(`/api/projects/${code}/tasks`)).json();
  for (const t of tasks.tasks || tasks) {
    const im = await (await fetch(`/api/tasks/${t.id}/images?limit=200`)).json();
    const withBoxes = (im.images || []).find((i) => i.id === want) || (im.images || []).find((i) => i.annotations > 0) || (im.images || [])[0];
    if (withBoxes) return { code, task: t.id, name: t.name, frame: withBoxes.id, boxes: withBoxes.annotations };
  }
  return null;
}, [PROJECT, process.env.FRAME || ""]);
console.log("кадр:", at);
if (!at) { await browser.close(); process.exit(0); }

await page.goto(`${BASE}/projects/${at.code}/tasks/${at.task}?frame=${at.frame}`);
await page.waitForSelector(".ed.fe", { timeout: 20000 });
await page.waitForTimeout(2200);
await page.screenshot({ path: `${OUT}/fe-main.png` });

// Выбор объекта: строка раскрывается, на холсте якоря
const row = page.locator(".fe-obj-r").first();
if (await row.count()) {
  await row.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/fe-selected.png` });
  await page.locator(".fe-side").screenshot({ path: `${OUT}/fe-side.png` });
}

// Наведение на вторую рамку: её подпись в полную силу
const second = page.locator(".mag-cv-sh .mag-cv-hit").nth(1);
if (await second.count()) {
  const b2 = await second.boundingBox();
  if (b2) { await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2); await page.waitForTimeout(300); }
  await page.screenshot({ path: `${OUT}/fe-hover.png` });
}

// Выбор класса
await page.locator(".ed-cls").click();
await page.waitForTimeout(350);
await page.screenshot({ path: `${OUT}/fe-classes.png` });
await page.keyboard.press("Escape");

// Настройки полуавтомата и контура
const more = page.locator(".ed-tool-more");
await more.nth(1).click();
await page.waitForTimeout(350);
await page.screenshot({ path: `${OUT}/fe-sam.png` });
await page.keyboard.press("Escape");
await more.nth(0).click();
await page.waitForTimeout(300);
await page.locator(".ed-set").screenshot({ path: `${OUT}/fe-poly.png` }).catch(() => {});
await page.keyboard.press("Escape");

// Меню правой кнопки на выбранной рамке
const box = page.locator(".mag-cv-sh.on .mag-cv-hit").first();
if (await box.count()) {
  const b = await box.boundingBox();
  if (b) {
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: "right" });
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/fe-menu.png` });
    await page.keyboard.press("Escape");
  }
}

// Клавиши и чистый кадр
await page.keyboard.press("Shift+Slash");
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/fe-keys.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.mouse.click(5, 300);
await page.keyboard.press("Tab");
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/fe-clean.png` });
await page.keyboard.press("Tab");

console.log("редактор открыт:", await page.locator(".ed.fe").count());
console.log("ошибки:", errors.length ? errors : "нет");
await browser.close();
