/** Проба редизайна: доска тасок и страница таски глазами браузера. Только смотрит — статусы не трогает. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5173";
const OUT = "/work/tests/e2e/test-results";
const PROJECT = process.env.PROJECT || "РСМ-2000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(BASE + "/");
console.log("вход:", await page.evaluate(async () => (await fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
})).status));

const code = await page.evaluate(async (name) => {
  const r = await (await fetch("/api/projects")).json();
  return (r.projects.find((p) => p.name === name) || r.projects[0]).code;
}, PROJECT);
console.log("проект:", code);

await page.goto(`${BASE}/projects/${code}/tasks`);
await page.waitForSelector(".tb, .ui-empty", { timeout: 20000 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/t-board.png` });
console.log("карточек:", await page.locator(".tb-card").count());

const first = page.locator(".tb-card").first();
if (await first.count()) {
  await first.click();
  await page.waitForSelector(".tp-two", { timeout: 20000 });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${OUT}/t-page.png`, fullPage: true });
  const segs = page.locator(".tp-segs").first();
  if (await segs.count()) {
    await segs.click();
    await page.waitForTimeout(400);
    await segs.screenshot({ path: `${OUT}/t-segs.png` }).catch(() => {});
  }
  const add = page.getByRole("button", { name: "Добавить" });
  if (await add.count()) {
    await add.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/t-add.png` });
    await page.keyboard.press("Escape");
  }
  const hist = page.getByRole("button", { name: "Вся история" });
  if (await hist.count()) {
    await hist.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/t-history.png` });
    await page.keyboard.press("Escape");
  }
}

console.log("ошибки:", errors.length ? errors : "нет");
await browser.close();
