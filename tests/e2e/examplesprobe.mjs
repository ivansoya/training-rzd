/** Образцы для «Сети по тексту» глазами браузера: окно сборки, полоса
 *  миниатюр, «убрать» как новый набор, порог строки, превью, версия.
 *  Агента заводит сама и сама же удаляет.
 *
 *   docker exec -w /work/tests/e2e -e PROJECT=<код> \
 *     -e NODE_PATH=/opt/e2e/node_modules yolo-tests node examplesprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const PROJECT = process.env.PROJECT;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
await page.goto(BASE + "/");
const graph = await page.evaluate(async (project) => {
  await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "123456" }),
  });
  const g = await (await fetch("/api/aug/graphs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Проба образцов", kind: "agent" }),
  })).json();
  const doc = { v: 1, nodes: [
    { id: "frame", type: "frame", params: {}, pos: [0, 120] },
    { id: "text", type: "text", pos: [260, 120], params: { model: "l", conf: 0.25, imgsz: 1280, prompts: [
      { kind: "text", prompt: "person", agent: "Человек", on: false }] } },
    { id: "out", type: "output", params: {}, pos: [540, 120] }],
    edges: [{ from: "frame", out: "out", to: "text", in: "in" }, { from: "text", out: "out", to: "out", in: "in" }] };
  await fetch(`/api/aug/graphs/${g.id}/draft`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc }) });
  localStorage.setItem(`agent-preview:${g.id}`, JSON.stringify({ project }));
  localStorage.setItem("agent-preview-open", "true");
  return g;
}, PROJECT);

const head = async () => (await page.locator(".ag-pv .g-pv-head").innerText()).replace(/\n/g, " ");
try {
  await page.goto(`${BASE}/agents/${graph.id}`);
  await page.locator(".g-node", { has: page.locator(".g-node-title", { hasText: /^Сеть по тексту/ }) }).click();
  await page.getByRole("button", { name: "+ Образцы из разметки" }).click();
  await page.locator("#ex-class option").first().waitFor({ state: "attached", timeout: 30000 });
  await page.selectOption("#ex-project", { label: "РСМ-2000 · тест" });
  await page.waitForTimeout(1000);
  const human = await page.locator("#ex-class option", { hasText: /^Человек/ }).getAttribute("value");
  await page.selectOption("#ex-class", human);
  await page.fill("#ex-n", "8");
  console.log("окно:", await page.locator(".ag-exnote").innerText());
  await page.screenshot({ path: `${OUT}/examples-dialog.png` });
  const t0 = Date.now();
  await page.getByRole("button", { name: "Собрать" }).click();
  await page.locator(".ag-th img").first().waitFor({ timeout: 180000 });
  console.log(`собрано за ${Date.now() - t0} мс, миниатюр:`, await page.locator(".ag-th").count(),
    "| в коллаже:", await page.locator(".ag-th.col").count());
  console.log("строка:", (await page.locator(".ag-src-btn").innerText()).replace(/\n/g, " | "),
    "| порог строки:", await page.locator(".ag-pr-thr").last().inputValue());

  const before = await page.locator(".ag-strip-src").innerText();
  await page.locator(".ag-th").first().hover();
  await page.locator(".ag-th .rm").first().click();
  await page.waitForTimeout(1500);
  console.log("после «убрать»:", await page.locator(".ag-th").count(), "|", before, "→",
    await page.locator(".ag-strip-src").innerText());

  await page.waitForTimeout(6000);
  console.log("превью:", await head(), "| рамок", await page.locator(".ag-pv-frame svg rect:not(.ag-pv-human)").count());
  await page.screenshot({ path: `${OUT}/examples-editor.png` });
  await page.getByRole("button", { name: "Сохранить версию" }).click();
  await page.waitForTimeout(2000);
  console.log("версия:", await page.locator(".mag-error, .ver").allInnerTexts());
} finally {
  await page.evaluate((id) => fetch(`/api/aug/graphs/${id}`, { method: "DELETE" }), graph.id);
  await browser.close();
}
