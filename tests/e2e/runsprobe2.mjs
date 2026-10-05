/** Проба: низ страницы прогона и строка «Продолжить» (только чтение). */
import { chromium } from "@playwright/test";
const BASE = process.env.BASE || "http://host.docker.internal:5174";
const CODE = process.env.CODE || "8CMYC2KSGXL5DAGAGRXE";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE + "/");
await page.evaluate(async () => fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }) }));
for (const n of (process.env.RUNS || "7").split(",")) {
  await page.goto(`${BASE}/projects/${CODE}/runs/${n}`);
  await page.waitForSelector(".rn-prm", { timeout: 20000 });
  await page.waitForTimeout(1000);
  for (const [i, y] of [[1, 700], [2, 1400], [3, 2400]]) {
    await page.evaluate((y) => document.querySelector(".shell-main").scrollTo(0, y), y);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/r-run${n}-${i}.png` });
  }
}
await browser.close();
