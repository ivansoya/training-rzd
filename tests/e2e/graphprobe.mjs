/** Проба редизайна графа: списки, редактор «Холст и шторка», узел на провод, окно 6 кадров. Граф заводит и удаляет сама. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const CODE = process.env.CODE || "XVW8MA6NGJ3A5RKRMRH5";
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

await page.goto(BASE + "/");
errors.length = 0;
console.log("вход:", (await call("POST", "/api/auth/login", { identity: "tester", password: "VniiTest" })).status);

const aug = (id, op, x, y, args = {}) => ({ id, type: "aug", pos: [x, y], params: { op, chance: 1, args } });
const doc = {
  v: 1,
  nodes: [
    { id: "src", type: "source", pos: [0, 160], params: { label: "Источник", name: "Источник" } },
    { id: "sp", type: "split_share", pos: [240, 160], params: { label: "Разделитель потока", branches: 2, shares: [60, 40] } },
    aug("rot", "Rotate", 480, 40, { limit: 8 }),
    aug("bc", "RandomBrightnessContrast", 720, 40),
    aug("snow", "RandomSnow", 480, 290),
    { id: "mg", type: "merge", pos: [960, 160], params: { label: "Слияние", inputs: 2 } },
    { id: "out", type: "output", pos: [1200, 160], params: { label: "Выход", name: "Выход" } },
    { id: "mul", type: "multiply", pos: [700, 430], params: { label: "Умножение", times: 3 } },
  ],
  edges: [
    { from: "src", out: "out", to: "sp", in: "in" },
    { from: "sp", out: "o0", to: "rot", in: "in" },
    { from: "rot", out: "out", to: "bc", in: "in" },
    { from: "bc", out: "out", to: "mg", in: "i0" },
    { from: "sp", out: "o1", to: "snow", in: "in" },
    { from: "snow", out: "out", to: "mg", in: "i1" },
    { from: "mg", out: "out", to: "out", in: "in" },
  ],
};
const made = await call("POST", "/api/aug/graphs", { name: `Проба графа ${Date.now() % 100000}`, description: "Зима и лето для путевой съёмки" });
const id = made.json.id;
console.log("граф:", made.status, id);
console.log("черновик:", (await call("PUT", `/api/aug/graphs/${id}/draft`, { doc })).status);
console.log("подключён:", (await call("POST", `/api/projects/${CODE}/aug`, { graph_id: id })).status);

try {
  await page.goto(`${BASE}/projects/${CODE}/aug`);
  await page.waitForSelector(".gl-row", { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/g-project.png`, fullPage: true });
  await page.getByRole("button", { name: "Подключить граф" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/g-project-attach.png` });
  await page.keyboard.press("Escape");

  await page.goto(`${BASE}/augment`);
  await page.waitForSelector(".gl-row", { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/g-library.png`, fullPage: true });

  await page.goto(`${BASE}/projects/${CODE}/aug`);
  await page.waitForSelector(".gl-row", { timeout: 20000 });
  await page.locator(".gl-row", { hasText: "Проба графа" }).first().click();
  await page.waitForSelector(".ge-node", { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/g-editor.png` });

  const node = (text) => page.locator(".react-flow__node", { has: page.locator(".ge-node-t", { hasText: text }) }).first();
  await node("Поворот").click();
  await page.waitForTimeout(300);
  await node("Поворот").locator(".ge-eye").click();
  await page.waitForSelector(".ge-cmp", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/g-editor-rot.png` });

  // Превью во весь экран: шторка, другой жребий, другой кадр
  await page.getByRole("button", { name: "Превью во весь экран" }).click();
  await page.waitForSelector(".ge-full .ge-cmp", { timeout: 10000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/g-full.png` });
  const desc0 = await page.locator(".ge-full .ui-dialog-d").innerText();
  await page.locator(".ge-full .ge-cmp").focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.locator(".ge-full").getByRole("button", { name: "Другой жребий" }).click();
  await page.locator(".ge-full").getByRole("button", { name: "Другой кадр" }).click();
  await page.waitForTimeout(2500);
  console.log("кадр во весь экран:", desc0, "→", await page.locator(".ge-full .ui-dialog-d").innerText(),
    "| шторка:", await page.locator(".ge-full .ge-cmp").getAttribute("aria-valuenow"));
  await page.screenshot({ path: `${OUT}/g-full-next.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Висящее «Умножение» — на провод «Яркость → Слияние»
  const wires0 = await page.locator(".react-flow__edge").count();
  const from = await node("Умножение").boundingBox();
  const label = page.locator(".ge-wl").nth(3);
  const wl = await label.boundingBox();
  await page.mouse.move(from.x + 40, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 10, { steps: 4 });
  const ax = wl.x + wl.width / 2, ay = wl.y + wl.height / 2;
  await page.mouse.move(ax, ay, { steps: 12 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/g-aim.png` });
  await page.mouse.up();
  await page.waitForTimeout(500);
  console.log("провода до/после узла на провод:", wires0, await page.locator(".react-flow__edge").count());

  // Узел из палитры — на провод
  const w1 = await page.locator(".react-flow__edge").count();
  const target = page.locator(".ge-wl").first();
  await page.locator(".ge-pal-i", { hasText: "Расфокус" }).first().dragTo(page.locator(".ge-canvas"), {
    targetPosition: await (async () => {
      const c = await page.locator(".ge-canvas").boundingBox();
      const t = await target.boundingBox();
      return { x: t.x - c.x + t.width / 2, y: t.y - c.y + t.height / 2 };
    })(),
  });
  await page.waitForTimeout(600);
  console.log("провода до/после из палитры:", w1, await page.locator(".react-flow__edge").count());
  await page.getByRole("button", { name: "Вписать граф" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/g-spliced.png` });

  // Шторка выше
  const grip = await page.locator(".ge-grip").boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 4);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 160, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/g-drawer-tall.png` });
  await page.locator(".ge-grip").dblclick();

  await node("Выход").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/g-output.png` });

  // Глаз снят повторным нажатием — превью идёт за выделением
  await node("Поворот").locator(".ge-eye").click();
  await node("Снег").click();
  await page.waitForTimeout(1500);
  console.log("превью после снятия глаза:", await page.getByRole("combobox", { name: "Узел в превью" }).innerText(),
    "| закреплено:", await page.locator(".ge-eye.on").count());
  await page.screenshot({ path: `${OUT}/g-follow.png` });
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Приблизить" }).click();
  await page.waitForTimeout(500);
  await node("Яркость").scrollIntoViewIfNeeded();
  const cv = await page.locator(".ge-canvas").boundingBox();
  await page.screenshot({ path: `${OUT}/g-cards.png`, clip: { x: cv.x, y: cv.y, width: cv.width, height: cv.height } });
  await page.getByRole("button", { name: "Вписать граф" }).click();

  await page.getByRole("button", { name: "Превью на 6 кадрах" }).click();
  await page.waitForSelector(".ge-six-pic", { timeout: 40000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/g-six.png` });
  await page.locator(".ge-six-flag span").first().click();
  await page.waitForTimeout(400);
  const f = await page.locator(".ui-dialog-f").boundingBox();
  console.log("курсор в подвале окна:", await page.evaluate(([x, y]) => [x, y].length && [0.3, 0.5, 0.6].map((k) => {
    const el = document.elementFromPoint(x[0] + x[1] * k, y);
    return `${el?.className || el?.tagName}:${getComputedStyle(el).cursor}`;
  }), [[f.x, f.width], f.y + f.height / 2]));
  await page.screenshot({ path: `${OUT}/g-six-before.png` });
  await page.keyboard.press("Escape");

  await node("Снег").click({ button: "right" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/g-menu.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Версия" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/g-versions.png` });
  await page.keyboard.press("Escape");

  await page.waitForTimeout(1200);
  const draft = await call("GET", `/api/aug/graphs/${id}`);
  console.log("в черновике узлов/проводов:", draft.json.doc.nodes.length, draft.json.doc.edges.length);

  // Чужой граф проекта — только чтение
  await page.goto(`${BASE}/projects/${CODE}/aug`);
  await page.waitForSelector(".gl-row", { timeout: 20000 });
  await page.locator(".gl-row", { hasText: "qa-aug сборка" }).first().click();
  await page.waitForSelector(".ge-node", { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.locator(".react-flow__node").nth(1).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/g-foreign.png` });
  console.log("назад ведёт в:", await page.locator(".ge-h a").first().getAttribute("href"));
} finally {
  console.log("отключён:", (await call("DELETE", `/api/projects/${CODE}/aug/${id}`)).status);
  console.log("удалён:", (await call("DELETE", `/api/aug/graphs/${id}`)).status);
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
