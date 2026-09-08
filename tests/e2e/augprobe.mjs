/** Смотрим глазами браузера на новые разделы: аугментации, обучение, железо.
 *
 * Снимки и вычисленные стили. Проверять вид «на слово» здесь уже дважды
 * оказывалось ошибкой: правка применялась к другому классу, а в диффе это
 * не видно.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://frontend";
const OUT = "test-results/aug";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
page.on("pageerror", (e) => console.log("ОШИБКА СТРАНИЦЫ:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("КОНСОЛЬ:", m.text());
});

await page.goto(BASE + "/");
const code200 = await page.evaluate(async () => {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "123456" }),
  });
  return r.status;
});
console.log("вход:", code200);

// --- 1. Библиотека графов -------------------------------------------------
await page.goto(BASE + "/augment");
await page.waitForSelector(".mag-content", { timeout: 15000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/01-library.png` });

const nav = await page.$$eval(".mag-topnav a, .mag-topnav span", (els) =>
  els.map((e) => e.textContent.trim())
);
console.log("верхняя строка:", nav.join(" / "));

// Заводим граф прямо через API — интересен редактор, а не форма.
const graph = await page.evaluate(async () => {
  const name = "проба-" + Math.random().toString(16).slice(2, 7);
  const r = await fetch("/api/aug/graphs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return r.ok ? await r.json() : { error: await r.text() };
});
console.log("граф:", graph.id ? `${graph.name} v${graph.version}` : graph);

// --- 2. Редактор ----------------------------------------------------------
await page.goto(`${BASE}/augment/${graph.id}`);
await page.waitForSelector(".g-node", { timeout: 15000 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/02-editor-empty.png` });

const palette = await page.$$eval(".g-pal-item", (els) => els.length);
const groups = await page.$$eval(".g-pal h4", (els) =>
  els.map((e) => e.textContent.trim())
);
console.log("узлов в палитре:", palette, "| группы:", groups.join(", "));

// Добавляем аугментацию щелчком и смотрим, что стало с числами на проводах.
await page.click(".g-pal-item.k-weather");
await page.waitForTimeout(400);
const nodesNow = await page.$$eval(".g-node-title", (els) =>
  els.map((e) => e.textContent.trim())
);
console.log("узлы на холсте:", nodesNow.join(" · "));

const wires = await page.$$eval(".g-wire-text", (els) =>
  els.map((e) => e.textContent.trim())
);
console.log("числа на проводах:", wires.join(" | ") || "нет");

// Ставим умножение и убеждаемся, что множитель поехал.
await page.click(".g-pal-item.k-flow >> nth=0");
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/03-editor-nodes.png` });

const mult = await page
  .$$eval(".g-canvas-top .ver", (els) => els.map((e) => e.textContent.trim()))
  .catch(() => []);
console.log("шапка редактора:", mult.join(" | "));

// Цвета: палитра «Габарита» и ничего лишнего.
const look = await page.evaluate(() => {
  const node = document.querySelector(".g-node");
  const pal = document.querySelector(".g-pal");
  const canvas = document.querySelector(".g-graph");
  const cs = (el) => (el ? getComputedStyle(el) : null);
  return {
    node: cs(node)?.backgroundColor,
    nodeBorder: cs(node)?.borderColor,
    palette: cs(pal)?.backgroundColor,
    canvas: cs(canvas)?.backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
  };
});
console.log("цвета:", JSON.stringify(look));

// --- 3. Раздел обучения в проекте ----------------------------------------
const project = await page.evaluate(async () => {
  const tag = "test-aug-" + Math.random().toString(16).slice(2, 8);
  const r = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: tag, description: "проба разделов" }),
  });
  return (await r.json()).code;
});
console.log("проект:", project);

await page.goto(`${BASE}/projects/${project}/training`);
await page.waitForSelector(".t-tabs", { timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/04-training-empty.png` });

const tabs = await page.$$eval(".g-ctx-nav a", (els) =>
  els.map((e) => e.textContent.trim())
);
console.log("вкладки проекта:", tabs.join(" / "));

await page.goto(`${BASE}/projects/${project}/aug`);
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/05-project-aug.png` });

// --- 4. Мастер сборки ----------------------------------------------------
await page.goto(`${BASE}/projects/${project}/training/new`);
await page.waitForSelector(".t-rail", { timeout: 15000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/06-wizard-step1.png` });

const steps = await page.$$eval(".t-rail div", (els) =>
  els.map((e) => e.textContent.trim())
);
console.log("шаги мастера:", steps.join(" → "));

// --- 5. Железо -----------------------------------------------------------
await page.goto(BASE + "/hardware");
await page.waitForSelector(".mag-content", { timeout: 15000 });
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/07-hardware.png`, fullPage: true });

const hw = await page.$eval(".mag-content", (el) => el.textContent.slice(0, 260));
console.log("железо:", hw.replace(/\s+/g, " "));

// Уборка за собой.
await page.evaluate(
  async ([project, graphId]) => {
    await fetch(`/api/projects/${project}`, { method: "DELETE" });
    await fetch(`/api/aug/graphs/${graphId}`, { method: "DELETE" });
  },
  [project, graph.id]
);

await browser.close();
console.log("снимки:", OUT);
