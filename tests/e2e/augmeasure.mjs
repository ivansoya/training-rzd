/** Что на самом деле применилось к узлам редактора: размеры и шрифты. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });

await page.goto(BASE + "/");
await page.evaluate(async () => {
  await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "123456" }),
  });
});

const graph = await page.evaluate(async () => {
  const r = await fetch("/api/aug/graphs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "мерка-" + Math.random().toString(16).slice(2, 7) }),
  });
  return await r.json();
});

await page.goto(`${BASE}/augment/${graph.id}`);
await page.waitForSelector(".g-node", { timeout: 15000 });
await page.waitForTimeout(700);

const got = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, нет: true };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      sel,
      w: Math.round(r.width),
      h: Math.round(r.height),
      font: `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight}`,
      family: cs.fontFamily.split(",")[0],
      color: cs.color,
    };
  };
  return {
    node: pick(".g-node"),
    title: pick(".g-node-title"),
    why: pick(".g-node-why"),
    save: pick(".g-canvas-top .mag-btn"),
    select: pick(".g-canvas-top select"),
    palItem: pick(".g-pal-item"),
    inspector: pick(".g-insp"),
    handle: pick(".react-flow__handle"),
    wire: pick(".g-wire-text"),
  };
});
console.log(JSON.stringify(got, null, 1));

// Что происходит с выделением после добавления узла.
await page.click(".g-pal-item.k-weather");
await page.waitForTimeout(500);
const selected = await page.evaluate(() => {
  const insp = document.querySelector(".g-insp");
  return {
    заголовок: insp?.querySelector(".g-insp-name")?.textContent ?? null,
    пусто: Boolean(insp?.textContent?.includes("Выберите узел")),
    выделено: document.querySelectorAll(".react-flow__node.selected").length,
  };
});
console.log("после добавления узла:", JSON.stringify(selected));

await page.evaluate(
  async (id) => fetch(`/api/aug/graphs/${id}`, { method: "DELETE" }),
  graph.id
);
await browser.close();
