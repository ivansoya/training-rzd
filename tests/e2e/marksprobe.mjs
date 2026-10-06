/** Проба: рамки в стиле холста вне редактора — превью агента и плитки датасета. Только смотрит. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(BASE + "/");
await page.evaluate(() => fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
}));

// Превью агента: первый агент из списка
await page.goto(BASE + "/agents");
await page.waitForSelector(".gl-row", { timeout: 20000 }).catch(() => {});
const row = page.locator(".gl-row").first();
if (await row.count()) {
  await row.click();
  await page.waitForSelector(".ae-frame .mk", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/mk-agent.png` });
  const f = page.locator(".ae-frame").first();
  if (await f.count()) await f.screenshot({ path: `${OUT}/mk-agent-frame.png` });
}

// Плитки датасета с рамками
const code = await page.evaluate(async () => {
  const r = await (await fetch("/api/projects")).json();
  return (r.projects.find((p) => p.name === "РСМ-2000") || r.projects[0]).code;
});
await page.goto(`${BASE}/projects/${code}/datasets`);
await page.waitForSelector(".fr-tile", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/mk-tiles.png` });

console.log("ошибки:", errors.length ? errors : "нет");
await browser.close();
