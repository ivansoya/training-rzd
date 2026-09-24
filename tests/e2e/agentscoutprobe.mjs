/** Разведка и разметка ролика агентом — глазами браузера.
 *
 * Снимки: окно запуска в режиме «Разведка», сводка в строке ролика и окно
 * статистики по ней, полосы над планом нарезки с выбором «Участки из
 * разведки», редактор размечаемого ролика — разведка по кнопке «Разведка» и
 * клавише R вместо треков, полоса прокрутки дорожек без ширины. План не
 * сохраняется, агент не запускается.
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

// Кнопка «Разведка» живёт у ролика: у нарезаемых — во вкладке
// «Кадры», у размечаемых — во «Видео». Разведан может быть любой из них.
await page.getByRole("button", { name: /^Кадры/ }).click();
await page.waitForSelector(".g-reel", { timeout: 30000 });
await page.waitForTimeout(800);
const cutScouted = (await page.locator(".g-reel .ag-scout-btn").count()) > 0;
if (!cutScouted) await page.getByRole("button", { name: /^Видео/ }).click();
const summary = page.locator(".ag-scout-btn").first();
await summary.waitFor({ timeout: 30000 });
console.log(`сводка во «${cutScouted ? "Кадрах" : "Видео"}»:`, await summary.innerText());
await page.screenshot({ path: `${OUT}/scout-summary.png` });

// Окно статистики — по строке сводки.
await summary.click();
await page.waitForSelector(".ag-stats .ag-stats-figs", { timeout: 30000 });
console.log("статистика:", (await page.locator(".ag-stats-meta").innerText()).replace(/\n/g, " "));
console.log("  числа:", (await page.locator(".ag-stats-figs").innerText()).replace(/\n/g, " "));
console.log("  классов в таблице:", await page.locator(".ag-stats-table tbody tr").count(),
  "| полос «по времени»:", await page.locator(".ag-stats-row").count(),
  "| вкладок:", await page.locator(".ag-stats-tabs button").count());
await page.screenshot({ path: `${OUT}/scout-stats.png` });
// Наведение на полосу: подсветка кадра во всех классах и подсказка сайта.
const bar = await page.locator(".ag-stats-strip").first().locator("rect").first().boundingBox();
await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
await page.waitForSelector(".ag-stats-tip", { timeout: 5000 });
console.log("  подсказка:", (await page.locator(".ag-stats-tip").innerText()).replace(/\n/g, " | "));
await page.screenshot({ path: `${OUT}/scout-stats-tip.png` });
await page.keyboard.press("Escape");
await page.waitForSelector(".ag-stats", { state: "detached" });

await page.getByRole("button", { name: "Агент" }).click();
await page.locator(".ag-run").getByRole("button", { name: "Разведка", exact: true }).click();
await page.locator(".ag-run .ag-blk input").first().check();
console.log("окно запуска:", (await page.locator(".ag-run .ag-foot").innerText()).replace(/\n/g, " | "));
await page.screenshot({ path: `${OUT}/scout-dialog.png` });
await page.getByRole("button", { name: "Отмена" }).click();

if (cutScouted) {
  await page.getByRole("button", { name: /^Кадры/ }).click();
  await page.getByRole("button", { name: /^Нарезать/ }).first().click();
  await page.waitForSelector(".ag-scout", { timeout: 30000 });
  await page.getByRole("button", { name: "Участки из разведки" }).click();
  // В план — участки одного класса, первого в списке: какие классы нашлись,
  // зависит от ролика.
  const picks = await page.locator(".ag-scout-pick label").all();
  for (const [i, label] of picks.entries()) {
    if (i === 0) await label.locator("input").check();
    else await label.locator("input").uncheck();
  }
  await page.screenshot({ path: `${OUT}/scout-cut-pick.png` });
  const before = await page.locator(".mag-cut-seg").count();
  await page.getByRole("button", { name: "Добавить в план" }).click();
  console.log("участков в плане:", before, "→", await page.locator(".mag-cut-seg").count());
  await page.screenshot({ path: `${OUT}/scout-cut-plan.png` });
  await page.locator(".mag-cut-btn[aria-label='Закрыть']").click();
} else {
  console.log("нарезаемый ролик не разведан — план из разведки не проверяю");
}

await page.getByRole("button", { name: /^Видео/ }).click();
await page.getByRole("button", { name: "Размечать" }).first().click();
await page.waitForSelector(".vt-timeline", { timeout: 60000 });
await page.waitForTimeout(1500);
const lanes = () => page.evaluate(() => ({
  разведка: document.querySelectorAll(".vt-scout").length,
  треков: document.querySelectorAll(".vt-row:not(.vt-scout)").length,
  подсказка: document.querySelectorAll(".vt-empty").length,
  полоса_px: (() => { const t = document.querySelector(".vt-timeline"); return t.offsetWidth - t.clientWidth; })(),
  бегунок: document.querySelectorAll(".vt-thumb").length,
}));
console.log("редактор, разведка выключена:", JSON.stringify(await lanes()));
await page.locator(".mag-ved-transport").getByRole("button", { name: "Разведка", exact: true }).click();
await page.waitForSelector(".vt-scout", { timeout: 10000 });
await page.waitForTimeout(500);
console.log("кнопкой включена:", JSON.stringify(await lanes()));
await page.screenshot({ path: `${OUT}/scout-editor.png` });
await page.keyboard.press("r");
await page.waitForTimeout(300);
console.log("клавишей R выключена:", JSON.stringify(await lanes()));
await browser.close();
