/** Проба: заголовок группы образцов на странице набора — фон и геометрия в покое и при наведении. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const CODE = process.env.CODE || "XVW8MA6NGJ3A5RKRMRH5";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE + "/");
await page.evaluate(async () => fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
}));
await page.goto(`${BASE}/projects/${CODE}/training`);
await page.locator(".ts-row", { hasText: process.env.SET || "qa-aug SS доли" }).first().click();
await page.waitForSelector(".ts-gal .fr-gt", { timeout: 20000 });
await page.waitForTimeout(1200);
const look = () => page.evaluate(() => {
  const pick = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return { bg: s.backgroundColor, pad: s.padding, radius: s.borderRadius, h: Math.round(r.height), w: Math.round(r.width), x: Math.round(r.x) }; };
  return { head: pick(document.querySelector(".ts-gal .fr-gh")), btn: pick(document.querySelector(".ts-gal .fr-gt")) };
});
console.log("покой:", JSON.stringify(await look()));
const head = page.locator(".ts-gal .fr-g").first();
await head.locator(".fr-gh").screenshot({ path: `${OUT}/h-rest.png` });
await page.locator(".ts-gal .fr-gt").first().hover();
await page.waitForTimeout(300);
console.log("наведение:", JSON.stringify(await look()));
await head.locator(".fr-gh").screenshot({ path: `${OUT}/h-hover.png` });
await browser.close();
