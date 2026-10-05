/** Проба редизайна: мастер набора («Собрать похожий»), все шаги со скриншотами. Набор не собирает, пока не BUILD=1. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const CODE = process.env.CODE || "XVW8MA6NGJ3A5RKRMRH5";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/401/.test(m.text()) && errors.push(m.text()));

await page.goto(BASE + "/");
console.log("вход:", await page.evaluate(async () => (await fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
})).status));

const sets = await page.evaluate(async (code) => (await (await fetch(`/api/projects/${code}/trainsets`)).json()).sets, CODE);
const from = sets.find((s) => s.name === (process.env.SET || "qa-aug G1 граф"));
await page.goto(`${BASE}/projects/${CODE}/training/new?from=${from.id}`);
await page.waitForSelector(".tw-steps", { timeout: 20000 });
await page.waitForSelector(".tw-sum", { timeout: 20000 }).catch(async () => {
  await page.screenshot({ path: `${OUT}/w-fail.png`, fullPage: true });
  console.log("итога нет; ошибки:", errors);
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/w-0.png`, fullPage: true });

for (const i of [1, 2, 3]) {
  await page.locator(".tw-side .ui-btn-primary").click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/w-${i}.png`, fullPage: true });
  if (i === 1) await page.locator(".tw-main .ui-card").first().screenshot({ path: `${OUT}/w-1-split.png` });
}
if (process.env.BUILD === "1") {
  await page.locator(".tw-side .ui-btn-primary").click();
  await page.waitForURL(/\/training$/, { timeout: 20000 });
  console.log("собрал:", page.url());
}
console.log("ошибки:", errors.length ? errors : "нет");
await browser.close();
