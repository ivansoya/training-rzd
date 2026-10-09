/** «Оборудование» глазами tester на текущем уровне прав: снимок и что видно. Ничего не меняет,
 *  кроме поиска в карточке «Доступ» (только набор, без выдачи).
 *
 *   docker exec -w /work/tests/e2e -e TAG=none -e NODE_PATH=/opt/e2e/node_modules yolo-tests node hwprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const TAG = process.env.TAG || "x";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
await page.goto(BASE + "/");
await page.evaluate(() => fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }) }));
await page.goto(`${BASE}/hardware`);
await page.waitForSelector(".hw .hw-card, .hw .ui-empty", { timeout: 20000 });
await page.waitForTimeout(900);
const text = async (sel) => (await page.locator(sel).first().innerText().catch(() => "—")).replace(/\s+/g, " ");
console.log(`[${TAG}] шапка:`, await text(".hw .ui-ph"));
console.log(`[${TAG}] карта:`, await text(".hw-card"));
console.log(`[${TAG}] очередь:`, await text(".hw-q"));
console.log(`[${TAG}] сайдбар:`, await text(".sb-gpu"));
if (await page.locator(".hw-acc").count()) {
  await page.getByLabel("Найти человека").fill("qa-ux");
  await page.waitForTimeout(800);
  console.log(`[${TAG}] доступ:`, await text(".hw-acc"));
}
await page.screenshot({ path: `${OUT}/hw-${TAG}.png`, fullPage: true });
await browser.close();
