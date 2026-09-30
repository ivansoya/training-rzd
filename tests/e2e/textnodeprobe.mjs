/** «Сеть по тексту» глазами браузера: палитра, таблица промтов, смена модели,
 *  превью YOLOE и SAM 3. Агента заводит сама и сама же удаляет.
 *
 *   docker exec -w /work/tests/e2e -e PROJECT=<код> \
 *     -e NODE_PATH=/opt/e2e/node_modules yolo-tests node textnodeprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const PROJECT = process.env.PROJECT;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
await page.goto(BASE + "/");
const graph = await page.evaluate(async (project) => {
  await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "123456" }),
  });
  const g = await (await fetch("/api/aug/graphs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Проба «Сети по тексту»", kind: "agent" }),
  })).json();
  const doc = { v: 1, nodes: [
    { id: "frame", type: "frame", params: {}, pos: [0, 120] },
    { id: "text", type: "text", pos: [260, 120], params: { model: "l", conf: 0.25, imgsz: 1280, prompts: [
      { prompt: "person", agent: "Человек", on: true }, { prompt: "worker", agent: "Человек", on: true }] } },
    { id: "nms", type: "nms", params: { iou: 0.6 }, pos: [520, 120] },
    { id: "out", type: "output", params: {}, pos: [780, 120] }],
    edges: [{ from: "frame", out: "out", to: "text", in: "in" }, { from: "text", out: "out", to: "nms", in: "in" },
      { from: "nms", out: "out", to: "out", in: "in" }] };
  await fetch(`/api/aug/graphs/${g.id}/draft`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc }) });
  localStorage.setItem(`agent-preview:${g.id}`, JSON.stringify({ project }));
  localStorage.setItem("agent-preview-open", "true");
  return g;
}, PROJECT);

const head = async () => (await page.locator(".ag-pv .g-pv-head").innerText()).replace(/\n/g, " ");
const node = (title) =>
  page.locator(".g-node", { has: page.locator(".g-node-title", { hasText: new RegExp(`^${title}`) }) });
try {
  await page.goto(`${BASE}/agents/${graph.id}`);
  await node("Сеть по тексту").first().click();
  console.log("карточка:", (await node("Сеть по тексту").first().innerText()).replace(/\n/g, " | "));
  console.log("модель нажата:", await page.locator(".ag-seg button[aria-pressed='true']").innerText());
  console.log("строк:", await page.locator(".ag-pr:not(.ag-cr-head)").count(),
    "| ×N:", await page.locator(".ag-pr .ag-merge").first().innerText());

  await page.fill("[aria-label='Новое слово']", "лопата");
  await page.fill("[aria-label='Класс агента для нового слова']", "Инструмент");
  await page.getByRole("button", { name: "+ Слово" }).click();
  console.log("кириллица:", await page.locator(".ag-pr.cyr .ag-pr-warn").innerText());
  await page.locator(".g-pv-frame img, .ag-pv-frame img").first().waitFor({ timeout: 90000 });
  await page.waitForTimeout(2500);
  console.log("превью YOLOE:", await head(), "| рамок", await page.locator(".ag-pv-frame svg rect:not(.ag-pv-human)").count());
  await page.screenshot({ path: `${OUT}/text-node-yoloe.png` });

  await page.getByRole("button", { name: "SAM 3" }).click();
  console.log("порог после смены:", await page.inputValue("#ag-conf"),
    "| плиток нет:", (await page.locator("text=Плитки размером").count()) === 0,
    "| контур:", await page.locator(".ag-cap").innerText());
  await page.waitForTimeout(45000);   // первый кадр SAM 3 — подъём модели
  console.log("превью SAM 3:", await head(), "| полигонов", await page.locator(".ag-pv-frame svg polygon:not(.ag-pv-human)").count());
  await page.screenshot({ path: `${OUT}/text-node-sam3.png` });

  await page.getByRole("button", { name: "l", exact: true }).click();
  console.log("порог обратно:", await page.inputValue("#ag-conf"));
  await page.getByRole("button", { name: "Сохранить версию" }).click();
  await page.waitForTimeout(1500);
  console.log("сохранение:", await page.locator(".mag-error, [role='status']").allInnerTexts());
} finally {
  await page.evaluate((id) => fetch(`/api/aug/graphs/${id}`, { method: "DELETE" }), graph.id);
  await browser.close();
}
