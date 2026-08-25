/** Окно нарезки: цвета оценки, игла и подмена ленты при увеличении. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const SAMPLE = process.env.SAMPLE || "/tmp/magistral-sample-300f.mp4";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("console", (m) => {
  if (m.type() === "error") console.log("консоль:", m.text().slice(0, 140));
});

await page.goto(BASE + "/");
await page.evaluate(async () => {
  await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "123456" }),
  });
});

const { code, taskId } = await page.evaluate(async () => {
  const tag = "test-cut-" + Math.random().toString(16).slice(2, 8);
  const p = await (await fetch("/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: tag, description: "проба" }),
  })).json();
  const t = await (await fetch(`/api/projects/${p.code}/tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "проба нарезки" }),
  })).json();
  await fetch(`/api/tasks/${t.id}/status`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "in_progress" }),
  });
  return { code: p.code, taskId: t.id };
});
console.log("таска:", taskId);

await page.goto(`${BASE}/projects/${code}/tasks/${taskId}`);
await page.waitForSelector(".mag-tabs .mag-tab");

// Загружаем ролик под нарезку через скрытое поле вкладки «Кадры».
const inputs = await page.$$('input[type="file"][accept="video/*"]');
await inputs[0].setInputFiles(SAMPLE);
await page.waitForSelector(".g-block", { timeout: 60000 });
console.log("ролик виден блоком в «Кадрах»");

// Открываем нарезку.
await page.getByRole("button", { name: /Нарезать/ }).first().click();
await page.waitForSelector(".mag-cut", { timeout: 20000 });

const box = await page.$eval(".mag-cut", (el) => {
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});
console.log("окно нарезки:", JSON.stringify(box));

const line = await page.$eval(".mag-cut-head-line", (el) => {
  const cs = getComputedStyle(el);
  return { фон: cs.backgroundColor, тень: cs.boxShadow.slice(0, 46) };
}).catch(() => null);
console.log("игла:", JSON.stringify(line));

const est = await page.$eval(".mag-est", (el) => {
  const cs = getComputedStyle(el);
  return { фон: cs.backgroundColor, рамка: cs.borderTopColor, цвет: cs.color };
}).catch(() => "нет оценки (участков не выбрано)");
console.log("оценка:", JSON.stringify(est));

// До увеличения — картинка с сервера.
const before = await page.$eval(".mag-cut-track", (el) => ({
  img: !!el.querySelector("img.mag-cut-strip"),
  canvas: !!el.querySelector("canvas.mag-cut-strip"),
}));
console.log("лента до увеличения:", JSON.stringify(before));

// Крутим колесо над дорожкой — увеличиваем.
const track = await page.$(".mag-cut-track");
const tb = await track.boundingBox();
for (let i = 0; i < 6; i += 1) {
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(90);
}
await page.waitForTimeout(1200);

const after = await page.$eval(".mag-cut-track", (el) => ({
  img: !!el.querySelector("img.mag-cut-strip"),
  canvas: !!el.querySelector("canvas.mag-cut-strip"),
}));
console.log("лента после увеличения:", JSON.stringify(after));

const hint = await page.$eval(".mag-cut-foot, .mag-cut-hint", (el) =>
  el.textContent.trim().slice(0, 60)).catch(() => null);
console.log("подсказка:", hint);

await page.screenshot({ path: "/tmp/ui-cut.png" });
await browser.close();
console.log("снимок: /tmp/ui-cut.png");
