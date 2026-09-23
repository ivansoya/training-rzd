/** Смотрим глазами браузера на узлы «Фильтр» и «Уточнение SAM» агента и на
 * полигоны, которые агент положил в таску.
 *
 *   docker exec -w /work/tests/e2e -e BASE=http://frontend -e AGENT=<id> \
 *     -e TASK=/projects/<код>/tasks/<id> -e NODE_PATH=/opt/e2e/node_modules \
 *     yolo-tests node agentsamprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("console", (m) => m.type() === "error" && console.log("  консоль:", m.text()));
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));

await page.goto(BASE + "/");
await page.evaluate(() =>
  fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "123456" }),
  })
);

await page.goto(`${BASE}/agents/${process.env.AGENT}`);
await page.waitForSelector(".g-node", { timeout: 15000 });
console.log("карточки:", await page.$$eval(".g-node", (ns) =>
  ns.map((n) => `${n.querySelector(".g-node-title")?.textContent} | ${n.querySelector(".g-node-why")?.textContent ?? ""}`)));
console.log("палитра:", await page.$$eval(".g-pal-item", (ns) => ns.map((n) => n.textContent)));
for (const [title, file] of [["Фильтр", "agent-filter"], ["Уточнение SAM", "agent-sam"]]) {
  await page.locator(".g-node", { has: page.locator(".g-node-title", { hasText: new RegExp(`^${title}$`) }) }).click();
  await page.waitForTimeout(300);
  console.log(title, "→", (await page.locator(".ag-node").innerText()).replace(/\n+/g, " | "));
  await page.screenshot({ path: `${OUT}/${file}.png` });
}

await page.goto(BASE + process.env.TASK);
await page.getByRole("button", { name: "Размечать" }).first().click();
await page.waitForTimeout(2500);
console.log("полигонов на кадре:", await page.locator("svg polygon, svg path").count());
await page.screenshot({ path: `${OUT}/agent-sam-task.png` });
await browser.close();
