/** Страница «Агенты» проекта глазами браузера: пустое состояние, подключение своего агента
 *  через «Подключить агента», карточка, журнал и раскрытая строка. Подключение остаётся.
 *
 *   docker exec -w /work/tests/e2e -e PROJECT=<код> -e NODE_PATH=/opt/e2e/node_modules yolo-tests node projectagentsprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const { PROJECT } = process.env;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1760, height: 1200 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("  консоль:", m.text()));
await page.goto(BASE + "/");
await page.evaluate(() => fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }) }));

await page.goto(`${BASE}/projects/${PROJECT}/agents`);
await page.waitForSelector(".pa .ui-ph", { timeout: 20000 });
await page.waitForTimeout(1200);
console.log("меню горит:", await page.locator("a[aria-current=page]").allInnerTexts());
await page.screenshot({ path: `${OUT}/pa-1.png`, fullPage: true });

if (!(await page.locator(".pa-agents tbody tr").count())) {
  await page.getByRole("button", { name: "Подключить агента" }).first().click();
  await page.waitForTimeout(400);
  console.log("в поповере:", (await page.locator(".gl-pick").innerText().catch(() => "—")).replace(/\s+/g, " "));
  await page.locator(".gl-pick [role=menuitem]:not([data-disabled]), .gl-pick button:not([disabled])").first().click();
  await page.waitForSelector(".pa-agents tbody tr", { timeout: 10000 });
  await page.waitForTimeout(800);
}
console.log("агент:", (await page.locator(".pa-agents tbody tr").first().innerText()).replace(/\s+/g, " "));
console.log("журнал:", (await page.locator(".pa-j .ui-card-h").innerText()).replace(/\s+/g, " "));
const rows = page.locator(".pa-runs tbody tr.gl-row");
console.log("строк:", await rows.count());
if (await rows.count()) {
  console.log("строка 1:", (await rows.first().innerText()).replace(/\s+/g, " "));
  await rows.first().click();
  await page.waitForSelector(".pa-xp", { timeout: 3000 });
  console.log("раскрыта:", (await page.locator(".pa-xp").innerText()).replace(/\s+/g, " "));
}
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/pa-2.png`, fullPage: true });

// Колонки не должны сдвигаться ни от раскрытия, ни посреди анимации
const cols = () => page.$$eval(".pa-runs thead th", (ths) => ths.map((t) => Math.round(t.getBoundingClientRect().left)).join(","));
const before = await cols();
const shifts = [];
for (const i of [1, 2, 1]) {
  await rows.nth(i).click();
  await page.waitForTimeout(120);
  shifts.push(await cols());
  await page.waitForTimeout(400);
  shifts.push(await cols());
}
console.log("колонки стоят:", shifts.every((c) => c === before) ? "да" : ["нет", before, ...shifts].join(" | "));
console.log("раскрыто строк:", await page.locator(".pa-xp").count(), "| высота блока:", await page.locator(".pa-x-w").first().evaluate((e) => Math.round(e.getBoundingClientRect().height)));

// Фильтр по статусу: «ошибка»
await page.getByRole("combobox", { name: "Статус" }).click();
await page.getByRole("option", { name: "ошибка" }).click();
await page.waitForTimeout(800);
console.log("ошибок:", await rows.count(), "|", (await page.locator(".pa-j .ui-card-h").innerText()).replace(/\s+/g, " "));
await browser.close();
