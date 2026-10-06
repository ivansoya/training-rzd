/** Проба блока «Тайлинг» в шторке агента: YOLOE и SAM 3 на кадре РСМ-2000. Агента заводит и удаляет сама. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const PROJECT = process.env.PROJECT || "M834L8GUXZHUW79TXBRM";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const call = (method, url, body) => page.evaluate(async ([method, url, body]) => {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [method, url, body]);

await page.goto(BASE + "/");
console.log("вход:", (await call("POST", "/api/auth/login", { identity: "tester", password: "VniiTest" })).status);

const rows = [{ kind: "text", prompt: "person", agent: "человек", on: true }, { kind: "text", prompt: "rail car", agent: "вагон", on: true }];
const doc = (params) => ({
  v: 1,
  nodes: [
    { id: "f", type: "frame", pos: [0, 120] },
    { id: "t", type: "text", pos: [260, 120], params: { model: "l", prompts: rows, conf: 0.25, imgsz: 1280, ...params } },
    { id: "o", type: "output", pos: [560, 120] },
  ],
  edges: [{ from: "f", out: "out", to: "t", in: "in" }, { from: "t", out: "out", to: "o", in: "in" }],
});
const made = await call("POST", "/api/aug/graphs", { name: `Проба тайлинга ${Date.now() % 100000}`, kind: "agent" });
const id = made.json.id;
console.log("агент:", made.status, id);

const shoot = async (name, params) => {
  console.log(name, "черновик:", (await call("PUT", `/api/aug/graphs/${id}/draft`, { doc: doc(params) })).status);
  await page.evaluate(([id, project]) => localStorage.setItem(`agent-preview:${id}`, JSON.stringify({ project })), [id, PROJECT]);
  await page.goto(`${BASE}/agents/${id}`);
  await page.waitForSelector(".react-flow__node-text", { timeout: 20000 });
  await page.locator(".react-flow__node-text").click();
  // два ответа превью: первый греет модель, второй даёт честное время
  await page.waitForSelector(".ae-tile-sum b", { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector(".ae-tile-sum b")?.textContent?.includes("после превью"), null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.locator(".ae-tile").screenshot({ path: `${OUT}/tile-${name}.png` });
  console.log(name, "итог:", (await page.locator(".ae-tile-sum").innerText()).replace(/\n/g, " | "));
  console.log(name, "узел:", await page.locator(".react-flow__node-text .ge-node-p").innerText());
};

try {
  await shoot("off", {});
  await shoot("yoloe", { tiles: true });
  await shoot("yoloe-640", { tiles: true, tile: 640, whole: false });
  await page.getByRole("button", { name: /Тонкая настройка/ }).click();
  await page.locator(".ae-tile").screenshot({ path: `${OUT}/tile-fine.png` });
  await shoot("sam3", { model: "sam3", conf: 0.4, tiles: true });
  await page.screenshot({ path: `${OUT}/tile-page.png` });
} finally {
  console.log("удалён:", (await call("DELETE", `/api/aug/graphs/${id}`)).status);
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
