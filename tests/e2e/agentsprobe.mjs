/** Проба редизайна агентов: список, редактор «Холст и шторка», превью, окна весов и 6 кадров, окно запуска в таске.
 *  Агента заводит и удаляет сама; в таске окно запуска только открывает. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const call = (method, url, body) => page.evaluate(async ([method, url, body]) => {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [method, url, body]);
const shot = (name, full) => page.screenshot({ path: `${OUT}/a-${name}.png`, fullPage: Boolean(full) });

await page.goto(BASE + "/");
console.log("вход:", (await call("POST", "/api/auth/login", { identity: "tester", password: "VniiTest" })).status);

const shelf = (await call("GET", "/api/agents/weights")).json.weights;
const w = shelf[0];
console.log("на полке:", shelf.length, w?.name);
const nodes = [
  { id: "frame", type: "frame", pos: [0, 160], params: {} },
  { id: "text", type: "text", pos: [260, 60], params: { model: "s", conf: 0.25, imgsz: 1280,
    prompts: [{ prompt: "person", agent: "человек", on: true }, { prompt: "car", agent: "машина", on: true }, { prompt: "вагон", agent: "вагон", on: false }] } },
  { id: "nms", type: "nms", pos: [780, 160], params: { iou: 0.6, agnostic: false } },
  { id: "flt", type: "filter", pos: [1040, 160], params: { classes: [], min_side: 12, max_side: null } },
  { id: "out", type: "output", pos: [1300, 160], params: {} },
];
const edges = [
  { from: "frame", out: "out", to: "text", in: "in" },
  { from: "nms", out: "out", to: "flt", in: "in" },
  { from: "flt", out: "out", to: "out", in: "in" },
];
if (w) {
  nodes.push({ id: "net", type: "net", pos: [260, 280], params: { weights: w.id, conf: 0.25, classes: w.names.map((n, i) => ({ agent: n, on: i < 3 })) } });
  nodes.push({ id: "mg", type: "merge", pos: [520, 160], params: { inputs: 2 } });
  edges.push({ from: "frame", out: "out", to: "net", in: "in" }, { from: "text", out: "out", to: "mg", in: "i0" },
    { from: "net", out: "out", to: "mg", in: "i1" }, { from: "mg", out: "out", to: "nms", in: "in" });
} else {
  edges.push({ from: "text", out: "out", to: "nms", in: "in" });
}
const doc = { v: 1, nodes, edges };
const made = await call("POST", "/api/aug/graphs", { name: `Проба агента ${Date.now() % 100000}`, kind: "agent" });
const id = made.json.id;
console.log("агент:", made.status, id, "версия:", (await call("POST", `/api/aug/graphs/${id}/versions`, { doc })).status);

let temp = null;
try {
  await page.goto(`${BASE}/agents`);
  await page.waitForSelector(".gl-row", { timeout: 20000 });
  await page.waitForTimeout(600);
  await shot("list", true);

  await page.locator(".gl-row", { hasText: "Проба агента" }).first().click();
  await page.waitForSelector(".ge-node", { timeout: 20000 });
  await page.waitForSelector(".ae-frame img", { timeout: 120000 });
  await page.waitForTimeout(2500);
  await shot("editor");

  const node = (text) => page.locator(".react-flow__node", { has: page.locator(".ge-node-t", { hasText: text }) }).first();
  await node("Сеть по тексту").click();
  await page.waitForTimeout(1500);
  await shot("text");
  if (w) {
    await node("Сеть —").click();
    await page.waitForTimeout(1200);
    await shot("net");
    await page.locator(".ge-drawer").getByRole("button", { name: "Сменить веса" }).click();
    await page.waitForTimeout(600);
    await shot("weights");
    await page.keyboard.press("Escape");
  }
  await node("Фильтр").click();
  await page.waitForTimeout(800);
  await shot("filter");

  // Правая кнопка — меню узла
  await node("NMS").click({ button: "right" });
  await page.waitForTimeout(300);
  await shot("menu");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Превью во весь экран" }).click();
  await page.waitForTimeout(1200);
  await shot("full");
  await page.keyboard.press("Escape");

  if (!process.env.NO_SIX) {
    await page.getByRole("button", { name: "Превью на 6 кадрах" }).click();
    await page.waitForSelector(".ge-six figure", { timeout: 180000 });
    await page.waitForTimeout(1500);
    await shot("six");
    await page.keyboard.press("Escape");
  }

  // Окно запуска в таске — во временном проекте, только открыть
  const proj = (await call("POST", "/api/projects", { name: `test-agents-${Date.now() % 100000}` })).json;
  temp = proj.code;
  await call("POST", `/api/projects/${temp}/classes`, { name: "человек" });
  const task = (await call("POST", `/api/projects/${temp}/tasks`, { name: "Проба агента" })).json;
  await call("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}`);
  // Окно запуска теперь внутри «Агента таски»
  await page.locator(".ui-ph-a").getByRole("button", { name: /Агент/ }).click();
  await page.getByRole("button", { name: "Разметить агентом…" }).click();
  await page.waitForSelector(".ar", { timeout: 20000 });
  await page.waitForTimeout(1200);
  await shot("run");
  await page.getByText("Разведка", { exact: true }).click();
  await page.waitForTimeout(400);
  await shot("run-scout");
  await page.keyboard.press("Escape");
} finally {
  if (temp) console.log("проект удалён:", (await call("DELETE", `/api/projects/${temp}`)).status);
  console.log("удалён:", (await call("DELETE", `/api/aug/graphs/${id}`)).status);
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
