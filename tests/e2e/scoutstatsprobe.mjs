/** Окно статистики разведки из полосы прогона — глазами браузера.
 *
 * Запускает разведку из окна «Разметить агентом» (агент AGENT, шаг 500, все
 * ролики таски), ждёт конца на открытой странице и открывает «Статистику» в
 * полосе прогона: разведано несколько роликов — должны быть вкладки. Пишет
 * разведку в таску, поэтому гонять только на песочнице проб.
 *
 *   docker exec -w /work/tests/e2e -e TASK=/projects/<код>/tasks/<id> \
 *     -e AGENT="<имя агента>" -e NODE_PATH=/opt/e2e/node_modules yolo-tests node scoutstatsprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
await page.goto(BASE + "/");
await page.evaluate(() =>
  fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "123456" }),
  })
);

await page.goto(BASE + process.env.TASK);
await page.getByRole("button", { name: "Агент" }).click();
await page.locator("#ag-agent").selectOption({ label: process.env.AGENT });
await page.locator(".ag-run").getByRole("button", { name: "Разведка", exact: true }).click();
for (const box of await page.locator(".ag-run .ag-blk input").all()) await box.check();
await page.locator("#ag-step").fill("500");
await page.locator(".ag-run .ag-foot .mag-btn").click();

const stats = page.getByRole("button", { name: "Статистика", exact: true });
await stats.waitFor({ timeout: 600000 });
console.log("полоса прогона:", (await page.locator(".ag-progress").innerText()).replace(/\n/g, " "));
await stats.click();
await page.waitForSelector(".ag-stats .ag-stats-figs", { timeout: 30000 });
const tabs = page.locator(".ag-stats-tabs button");
console.log("вкладки:", (await tabs.allInnerTexts()).join(" | "));
console.log("  выбрана:", await page.locator('.ag-stats-tabs button[aria-selected="true"]').innerText(),
  "| числа:", (await page.locator(".ag-stats-figs").innerText()).replace(/\n/g, " "));
await page.screenshot({ path: `${OUT}/scout-stats-run.png` });
if ((await tabs.count()) > 1) {
  await tabs.nth(1).click();
  await page.waitForSelector(".ag-stats .ag-stats-figs", { timeout: 30000 });
  console.log("  вторая вкладка:", (await page.locator(".ag-stats-figs").innerText()).replace(/\n/g, " "));
  await page.screenshot({ path: `${OUT}/scout-stats-tab2.png` });
}
await page.keyboard.press("Escape");
console.log("строк сводки под роликами:", await page.locator(".ag-scout-sum").count());
await browser.close();
