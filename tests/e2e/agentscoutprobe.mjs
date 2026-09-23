/** Разведка и разметка ролика агентом — глазами браузера.
 *
 * Снимки: окно запуска в режиме «Разведка», сводка в строке ролика, полосы
 * над планом нарезки с выбором «Участки из разведки», дорожки разведки в
 * редакторе размечаемого ролика. План не сохраняется, агент не запускается.
 *
 *   docker exec -w /work/tests/e2e -e TASK=/projects/<код>/tasks/<id> \
 *     -e NODE_PATH=/opt/e2e/node_modules yolo-tests node agentscoutprobe.mjs
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
await page.getByRole("button", { name: /^Кадры/ }).click();
await page.waitForSelector(".g-reel", { timeout: 30000 });
await page.waitForTimeout(800);
console.log("сводка в «Кадрах»:", await page.locator(".g-reel .ag-scout-sum").first().innerText());
await page.screenshot({ path: `${OUT}/scout-frames-tab.png` });

await page.getByRole("button", { name: "Агент" }).click();
await page.getByRole("button", { name: "Разведка" }).click();
await page.locator(".ag-run .ag-blk input").first().check();
console.log("окно запуска:", (await page.locator(".ag-run .ag-foot").innerText()).replace(/\n/g, " | "));
await page.screenshot({ path: `${OUT}/scout-dialog.png` });
await page.getByRole("button", { name: "Отмена" }).click();

await page.getByRole("button", { name: /^Нарезать/ }).first().click();
await page.waitForSelector(".ag-scout", { timeout: 30000 });
await page.getByRole("button", { name: "Участки из разведки" }).click();
await page.locator(".ag-scout-pick label", { hasText: /^\s*Человек/ }).locator("input").check();
for (const other of await page.locator(".ag-scout-pick label").all()) {
  if (!(await other.innerText()).includes("Человек")) await other.locator("input").uncheck();
}
await page.screenshot({ path: `${OUT}/scout-cut-pick.png` });
const before = await page.locator(".mag-cut-seg").count();
await page.getByRole("button", { name: "Добавить в план" }).click();
console.log("участков в плане:", before, "→", await page.locator(".mag-cut-seg").count());
await page.screenshot({ path: `${OUT}/scout-cut-plan.png` });
await page.locator(".mag-cut-btn[aria-label='Закрыть']").click();

await page.getByRole("button", { name: /^Видео/ }).click();
await page.getByRole("button", { name: "Размечать" }).first().click();
await page.waitForSelector(".vt-scout", { timeout: 60000 });
console.log("дорожек разведки в редакторе:", await page.locator(".vt-scout").count());
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/scout-editor.png` });
await browser.close();
