/** Проба списка классов агента: старый черновик переводится, окно классов, класс из проекта,
 *  версия с паспортом, окно запуска с замком на ссылке. Агента заводит и удаляет сама. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const CODE = process.env.CODE || "M834L8GUXZHUW79TXBRM";
const TASK = process.env.TASK || "2d191302-b26c-43cc-baf0-a4c57f3b43f5";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(m.text()));

const call = (method, url, body) => page.evaluate(async ([method, url, body]) => {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [method, url, body]);

await page.goto(BASE + "/");
console.log("вход:", (await call("POST", "/api/auth/login", { identity: "tester", password: "VniiTest" })).status);

// Черновик старого вида: имена классов прямо в строках, списка нет.
const old = {
  v: 1,
  nodes: [
    { id: "f", type: "frame", pos: [0, 120] },
    { id: "t", type: "text", pos: [260, 120], params: { model: "l", conf: 0.25, imgsz: 1280, prompts: [
      { kind: "text", prompt: "person", agent: "человек", on: true },
      { kind: "text", prompt: "rail car", agent: "вагон", on: true },
      { kind: "text", prompt: "hammer", agent: "инструмент", on: false },
    ] } },
    { id: "o", type: "output", pos: [560, 120] },
  ],
  edges: [{ from: "f", out: "out", to: "t", in: "in" }, { from: "t", out: "out", to: "o", in: "in" }],
};
const made = await call("POST", "/api/aug/graphs", { name: `Проба классов ${Date.now() % 100000}`, kind: "agent" });
const id = made.json.id;
console.log("агент:", made.status, id, "черновик:", (await call("PUT", `/api/aug/graphs/${id}/draft`, { doc: old })).status);

try {
  await page.evaluate(([id, project]) => localStorage.setItem(`agent-preview:${id}`, JSON.stringify({ project })), [id, CODE]);
  await page.goto(`${BASE}/agents/${id}`);
  await page.waitForSelector(".react-flow__node-text", { timeout: 20000 });
  const head = page.getByRole("button", { name: /класс/ }).first();
  console.log("шапка:", await head.innerText());
  await head.click();
  await page.waitForSelector(".acl-r:not(.head)");
  console.log("классы:", await page.locator(".acl-r:not(.head)").allInnerTexts());
  await page.locator(".ui-dialog").screenshot({ path: `${OUT}/cls-dialog.png` });

  // Класс из проекта: РСМ-2000, «Человек» — имя совпадает с нашим «человек», он станет ссылкой.
  await page.getByRole("button", { name: "Из проекта…" }).click();
  await page.locator(".acl-pick-h .ui-select, .acl-pick-h button").first().click();
  await page.getByRole("option", { name: /РСМ-2000/ }).first().click().catch(async () => {
    await page.getByText(/РСМ-2000/).last().click();
  });
  await page.waitForTimeout(300);
  await page.locator(".acl-pick-r", { hasText: "Человек" }).locator("input").check();
  await page.locator(".acl-pick-r", { hasText: "Инструмент" }).locator("input").check();
  await page.locator(".ui-dialog").screenshot({ path: `${OUT}/cls-pick.png` });
  await page.getByRole("button", { name: /^Добавить/ }).click();
  await page.waitForTimeout(300);
  console.log("после добавления:", await page.locator(".acl-r:not(.head)").allInnerTexts());
  await page.locator(".ui-dialog").screenshot({ path: `${OUT}/cls-linked.png` });
  await page.getByRole("button", { name: "Готово" }).click();

  // Строка «hammer» включается — класс «инструмент» уже есть (ссылкой), новый не заводится.
  await page.locator(".react-flow__node-text").click();
  await page.waitForSelector(".ae-ct-row.pr");
  await page.getByRole("checkbox", { name: "hammer" }).check();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/cls-editor.png` });
  console.log("шапка после:", await head.innerText());

  const draft = (await call("GET", `/api/aug/graphs/${id}`)).json.doc;
  console.log("черновик классов:", JSON.stringify(draft.classes));
  console.log("строки:", JSON.stringify(draft.nodes.find((n) => n.id === "t").params.prompts.map((r) => [r.prompt, r.cls, r.on])));
  const saved = await call("POST", `/api/aug/graphs/${id}/versions`, { doc: draft });
  console.log("версия:", saved.status, saved.json?.error ?? JSON.stringify(saved.json?.stats?.classes));

  const ctx = (await call("GET", `/api/agents/tasks/${TASK}`)).json;
  const mine = ctx.agents.find((a) => a.id === id);
  console.log("в окне запуска:", JSON.stringify(mine?.versions[0].classes.map((c) => [c.name, c.lock ? "замок" : "—"])));

  await page.goto(`${BASE}/projects/${CODE}/tasks/${TASK}`);
  await page.getByRole("button", { name: /агент/i }).first().click();
  await page.waitForSelector(".ar");
  await page.getByRole("combobox", { name: "Агент" }).click().catch(() => {});
  await page.getByRole("option", { name: new RegExp(made.json.name) }).click().catch(() => {});
  await page.waitForTimeout(500);
  await page.locator(".ui-dialog").screenshot({ path: `${OUT}/cls-run.png` });
} finally {
  console.log("удалён:", (await call("DELETE", `/api/aug/graphs/${id}`)).status);
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
