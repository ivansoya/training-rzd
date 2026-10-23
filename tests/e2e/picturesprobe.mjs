/** «Свои картинки» в окне «Образцы класса» глазами браузера (решения 23.10.2026): полка, загрузка,
 *  рамки мышью, щелчок по рамке в набор, «Случайно», сохранение набора. Заводит своего агента
 *  у tester и в конце убирает его и картинки. Снимки — в OUT.
 *
 *   docker exec -w /work/tests/e2e -e PICS=/work/tests/e2e/test-results/hw -e NODE_PATH=/opt/e2e/node_modules \
 *     yolo-tests node picturesprobe.mjs
 */
import { readdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const PICS = process.env.PICS;
const files = readdirSync(PICS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => `${PICS}/${f}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
await page.goto(BASE + "/");
const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/api/${p}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, [method, path, body]);
for (const password of [process.env.PASS, "VniiTest", "123456"].filter(Boolean)) {
  if ((await api("POST", "auth/login", { identity: "tester", password })).status === 200) break;
}

const graph = (await api("POST", "aug/graphs", { name: `Проба своих картинок ${Date.now()}`, kind: "agent" })).body;
const doc = (model) => ({ v: 1, classes: [{ id: "c1", name: "Борщевик", color: "#ffe629" }], nodes: [
  { id: "frame", type: "frame", params: {}, pos: [60, 200] },
  { id: "text", type: "text", pos: [320, 200], params: { label: "SAM 3", model, side: 1008,
    prompts: [{ on: true, kind: "text", prompt: "hogweed", cls: "c1", conf: 0.4 }] } },
  { id: "out", type: "output", params: {}, pos: [600, 200] }],
  edges: [{ from: "frame", out: "out", to: "text", in: "in" }, { from: "text", out: "out", to: "out", in: "in" }] });
let saved = await api("POST", `aug/graphs/${graph.id}/versions`, { doc: doc("sam3") });
if (saved.status >= 300) saved = await api("POST", `aug/graphs/${graph.id}/versions`, { doc: doc("l") });
console.log("агент:", graph.id, "версия:", saved.status);

try {
  await page.goto(`${BASE}/agents/${graph.id}`);
  await page.waitForSelector(".ge-flow .ge-node", { timeout: 30000 });
  await page.locator(".ge-node", { has: page.locator(".ge-node-t", { hasText: "SAM 3" }) }).click();
  const card = page.locator(".ae-card", { has: page.locator(".ae-card-n b", { hasText: "Борщевик" }) }).first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await card.locator(".ae-card-h button[aria-label^='Ещё']").click();
  await page.locator(".ui-pop").getByText("Выбрать образцы…").click();
  await page.waitForSelector(".ep", { timeout: 15000 });

  await page.getByRole("button", { name: /Свои картинки/ }).click();
  await page.waitForTimeout(500);
  console.log("пустая полка:", await page.locator(".ep-drop.big").innerText().catch(() => "нет").then((t) => t.replace(/\n/g, " | ")));
  await page.screenshot({ path: `${OUT}/pics-1-empty.png` });

  await page.locator(".ep-gal input[type=file]").setInputFiles(files);
  // waitForFunction страница не пустит: CSP без unsafe-eval.
  const done = page.locator(".ep-pc:not(.busy):not(.bad)");
  for (let t = 0; t < 240 && (await done.count()) < files.length; t++) await page.waitForTimeout(500);
  console.log("карточек:", await page.locator(".ep-pc").count(), "| строка:", (await page.locator(".ep-tools .t-xs").first().innerText()).replace(/\s+/g, " "));
  await page.screenshot({ path: `${OUT}/pics-2-uploaded.png` });

  // Окно рамок: две рамки мышью на первой картинке, одна на второй
  await page.locator(".ep-pc .ep-pc-in").first().click({ position: { x: 5, y: 5 } });
  await page.waitForSelector(".ep-ed-wrap img", { timeout: 15000 });
  await page.waitForTimeout(800);
  const draw = async (a, b) => {
    const r = await page.locator(".ep-ed-wrap").boundingBox();
    await page.mouse.move(r.x + r.width * a[0], r.y + r.height * a[1]);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * b[0], r.y + r.height * b[1], { steps: 8 });
    await page.mouse.up();
  };
  await draw([0.25, 0.1], [0.75, 0.9]);
  await draw([0.02, 0.6], [0.2, 0.95]);
  console.log("на первой:", await page.locator(".ep-ed-side > b").innerText(), "| размеры:", (await page.locator(".ep-bl .num").allInnerTexts()).join(", "));
  await page.screenshot({ path: `${OUT}/pics-3-editor.png` });
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1200);
  await draw([0.2, 0.15], [0.7, 0.95]);
  console.log("на второй:", await page.locator(".ep-ed-side > b").innerText(), "|", await page.locator(".ep-ed .ui-dialog-t .t-faint").innerText());
  await page.getByRole("button", { name: "Готово" }).click();
  await page.waitForSelector(".ep-ed", { state: "detached", timeout: 15000 });
  await page.waitForTimeout(500);
  console.log("после «Готово»:", (await page.locator(".ep-tools .t-xs").first().innerText()).replace(/\s+/g, " "));

  // Рамка в набор щелчком, потом «Случайно»
  await page.locator(".ep-pc .ep-bx").first().click();
  await page.waitForTimeout(300);
  console.log("в наборе после щелчка:", await page.locator(".ep-th").count(), "| номер на рамке:", await page.locator(".ep-pc .ep-bx.on b").first().innerText());
  await page.getByRole("button", { name: /Случайно \+\d+ разных/ }).click();
  await page.waitForTimeout(2500);
  console.log("в наборе после «Случайно»:", await page.locator(".ep-th").count(), "| своих:", await page.locator(".ep-th .own").count(),
    "| коллаж:", (await page.locator(".ep-col-pic img").count()) ? "есть" : await page.locator(".ep-col-pic").innerText());
  await page.screenshot({ path: `${OUT}/pics-4-set.png` });

  await page.getByRole("button", { name: "Сохранить набор" }).click();
  await page.waitForSelector(".ep", { state: "detached", timeout: 240000 });
  await page.waitForTimeout(1500);
  console.log("карточка класса:", (await card.innerText()).replace(/\s+/g, " ").slice(0, 160));
  await card.screenshot({ path: `${OUT}/pics-5-card.png` });
} finally {
  const pics = (await api("GET", "agents/pictures")).body.pictures ?? [];
  for (const p of pics.filter((x) => x.shelf === "Борщевик")) console.log("убрать картинку:", p.file_name, (await api("DELETE", `agents/pictures/${p.id}`)).status);
  console.log("убрать агента:", (await api("DELETE", `aug/graphs/${graph.id}`)).status);
  await browser.close();
}
