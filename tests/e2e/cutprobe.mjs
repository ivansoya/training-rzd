/** Проба окна нарезки: временный test-проект с роликом, участки протяжкой, меню шага, итог. Проект удаляет сама. */
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const SAMPLE = process.env.SAMPLE || "/tmp/magistral-sample-300f.mp4";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const shot = (name) => page.screenshot({ path: `${OUT}/cut-${name}.png` });
const api = page.request;

await page.goto(BASE + "/");
console.log("вход:", (await api.post(`${BASE}/api/auth/login`, { data: { identity: "tester", password: "VniiTest" } })).status());
const project = await (await api.post(`${BASE}/api/projects`, { data: { name: `test-cut-${Date.now() % 100000}` } })).json();
try {
  const task = await (await api.post(`${BASE}/api/projects/${project.code}/tasks`, { data: { name: "Проба нарезки" } })).json();
  await api.post(`${BASE}/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });
  const up = await api.post(`${BASE}/api/tasks/${task.id}/videos`, {
    multipart: { file: { name: "путь-300.mp4", mimeType: "video/mp4", buffer: readFileSync(SAMPLE) }, mode: "cut" },
  });
  console.log("ролик:", up.status());

  await page.goto(`${BASE}/projects/${project.code}/tasks/${task.id}`);
  await page.getByRole("button", { name: "Нарезать", exact: true }).click();
  await page.waitForSelector(".vc-track", { timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot("empty");

  const box = await page.locator(".vc-track").boundingBox();
  const drag = async (a, b) => {
    await page.mouse.move(box.x + box.width * a, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * ((a + b) / 2), box.y + box.height / 2, { steps: 6 });
    await page.mouse.move(box.x + box.width * b, box.y + box.height / 2, { steps: 6 });
  };
  await drag(0.08, 0.35);
  await shot("drawing");
  await page.mouse.up();
  await drag(0.55, 0.8);
  await page.mouse.up();
  await page.keyboard.press("KeyF");
  await page.waitForTimeout(1200);
  await shot("two");

  await page.locator(".vc-seg b").first().click({ button: "right" });
  await page.waitForTimeout(300);
  await shot("menu");
  await page.keyboard.press("Escape");

  await page.keyboard.press("KeyH");
  await page.waitForTimeout(200);
  console.log("инструмент после H:", await page.locator(".vc-track").getAttribute("class"));
  await page.getByRole("button", { name: /^Применить/ }).click();
  await page.getByText("Нарезано").waitFor({ timeout: 60000 });
  await shot("done");
  await page.getByRole("button", { name: "Вернуться к таске" }).click();
  await page.waitForTimeout(1200);
  await shot("task");
} finally {
  console.log("проект удалён:", (await api.delete(`${BASE}/api/projects/${project.code}`)).status());
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
