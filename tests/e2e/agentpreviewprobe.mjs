/** Превью агента глазами браузера: выход, «Фильтр» с отсеянным, «SAM».
 *
 *   docker exec -w /work/tests/e2e -e AGENT=<id> -e PROJECT=<код> \
 *     -e NODE_PATH=/opt/e2e/node_modules yolo-tests node agentpreviewprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const AGENT = process.env.AGENT;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
await page.goto(BASE + "/");
await page.evaluate(
  ([agent, project]) => {
    localStorage.setItem(`agent-preview:${agent}`, JSON.stringify({ project }));
    localStorage.setItem("agent-preview-open", "true");
    return fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: "tester", password: "123456" }),
    });
  },
  [AGENT, process.env.PROJECT]
);

await page.goto(`${BASE}/agents/${AGENT}`);
const t0 = Date.now();
await page.waitForSelector(".ag-pv-frame img", { timeout: 60000 });
console.log(`первый кадр за ${Date.now() - t0} мс:`, await page.locator(".ag-pv .g-pv-head").innerText());
await page.screenshot({ path: `${OUT}/agent-preview-out.png` });

const node = (title) =>
  page.locator(".g-node", { has: page.locator(".g-node-title", { hasText: new RegExp(`^${title}`) }) });

await node("Фильтр").click();
await page.fill("#ag-min_side", "60");
await page.waitForTimeout(1500);
console.log("фильтр:", (await page.locator(".ag-pv .g-pv-head").innerText()).replace(/\n/g, " "));
console.log("  пунктиров:", await page.locator(".ag-pv-frame svg [style*='stroke-dasharray']").count());
await page.screenshot({ path: `${OUT}/agent-preview-filter.png` });

await node("Уточнение SAM").click();
await page.waitForTimeout(500);
console.log("SAM:", (await page.locator(".ag-pv .g-pv-head").innerText()).replace(/\n/g, " "),
  "| полигонов", await page.locator(".ag-pv-frame svg polygon:not(.ag-pv-human)").count());
await page.screenshot({ path: `${OUT}/agent-preview-sam.png` });

await page.getByRole("button", { name: "→" }).click();
await page.waitForTimeout(1500);
console.log("следующий кадр:", await page.locator(".ag-pv-name").innerText());
await browser.close();
