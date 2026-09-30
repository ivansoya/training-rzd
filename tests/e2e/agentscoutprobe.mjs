/** Разведка роликов агентом — глазами браузера.
 *
 * Смотрит (решения владельца 24.09.2026): общую статистику таски по кнопке в
 * шапке — список роликов слева, «Все ролики» и ролик по щелчку; приближение
 * шкалы колесом и карточку с кадром при наведении; окно ролика по его кнопке
 * «Разведка» — без вкладок; полосу разведки под лентой нарезки с чипами
 * классов и «Участки в план»; разведку вместо треков в редакторе ролика по
 * кнопке и клавише R. План не сохраняется, агент не запускается.
 *
 *   docker exec -w /work/tests/e2e -e TASK=/projects/<код>/tasks/<id> \
 *     -e NODE_PATH=/opt/e2e/node_modules yolo-tests node agentscoutprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const flat = (s) => s.split("\n").join(" | ");

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

// --- общая статистика таски ------------------------------------------------ //
await page.getByRole("button", { name: "Статистика разведки" }).click();
await page.waitForSelector(".ag-ov .ag-stats-figs", { timeout: 60000 });
const items = page.locator(".ag-ov-item");
console.log("общая: роликов в списке", (await items.count()) - 1,
  "| числа:", flat(await page.locator(".ag-ov .ag-stats-figs").innerText()));
console.log("  классов в таблице:", await page.locator(".ag-ov .ag-stats-table tbody tr").count(),
  "| полос «где по роликам»:", await page.locator(".ag-ov .ag-ov-where").count());
await page.screenshot({ path: `${OUT}/scout-overview.png` });

// ролик с находками — у кого больше рамок
let best = 1;
let most = -1;
for (let i = 1; i < await items.count(); i++) {
  const n = Number((await items.nth(i).locator(".ag-ov-meta span").last().innerText()).replace(/\D/g, ""));
  if (n > most) { most = n; best = i; }
}
await items.nth(best).click();
await page.waitForSelector(".ag-ov .ag-tl", { timeout: 10000 });
console.log("  ролик:", await page.locator(".ag-ov-pane h2").innerText(), "|", await page.locator(".ag-tl-win").innerText());
const strip = page.locator(".ag-ov .ag-stats-strips .ag-stats-strip").first();
const box = await strip.boundingBox();
await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(80); }
console.log("  колесом:", await page.locator(".ag-tl-win").innerText(),
  "| отметок на шкале:", await page.locator(".ag-ov .ag-stats-axis span").count());
// навести на столбик с находкой
const bar = page.locator(".ag-ov .ag-stats-strips .ag-stats-strip").first().locator("rect").nth(1);
const bb = await bar.boundingBox();
if (bb) {
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForSelector(".ag-peek", { timeout: 5000 });
  await page.waitForSelector(".ag-peek-img.on", { timeout: 20000 }).catch(() => {});
  console.log("  карточка:", flat(await page.locator(".ag-peek-body").innerText()),
    "| кадр загружен:", (await page.locator(".ag-peek-img.on").count()) === 1,
    "| ширина кадра:", await page.locator(".ag-peek-img img").evaluate((i) => i.naturalWidth).catch(() => 0));
  await page.screenshot({ path: `${OUT}/scout-overview-video.png` });
}
await page.keyboard.press("Escape");
await page.waitForSelector(".ag-ov", { state: "detached" });

// --- окно ролика по его кнопке ------------------------------------------- //
await page.getByRole("button", { name: /^Видео/ }).click();
await page.locator(".g-block-h").getByRole("button", { name: "Разведка", exact: true }).first().click();
await page.waitForSelector(".ag-stats .ag-stats-figs", { timeout: 30000 });
console.log("окно ролика:", await page.locator(".ag-stats-video").innerText(),
  "| вкладок:", await page.locator(".ag-stats [role=tab]").count());
await page.keyboard.press("Escape");

// --- нарезка: полоса под лентой ------------------------------------------ //
await page.getByRole("button", { name: /^Кадры/ }).click();
const cutButton = page.locator(".g-reel").getByRole("button", { name: "Разведка", exact: true });
await cutButton.first().waitFor({ timeout: 8000 }).catch(() => {});
const cutScouted = await cutButton.count();
if (cutScouted) {
  await page.getByRole("button", { name: /^Нарезать/ }).first().click();
  await page.waitForSelector(".ag-band-bar", { timeout: 30000 });
  await page.waitForTimeout(800);
  const band = await page.locator(".ag-band-bar").boundingBox();
  const track = await page.locator(".mag-cut-track").boundingBox();
  console.log("нарезка: полоса под лентой — зазор", Math.round(band.y - (track.y + track.height)), "px, края",
    Math.round(band.x - track.x), "/", Math.round((band.x + band.width) - (track.x + track.width)),
    "| высота", Math.round(band.height), "| чипов", await page.locator(".ag-band-chip").count());
  await page.mouse.move(band.x + band.width * 0.3, band.y + band.height / 2);
  await page.waitForTimeout(400);
  console.log("  карточка над полосой:", await page.locator(".ag-peek").count());
  await page.screenshot({ path: `${OUT}/scout-cut-band.png` });
  const before = await page.locator(".mag-cut-seg").count();
  const lanesBefore = await page.locator(".ag-band-bar rect").count();
  await page.locator(".ag-band-chip").first().click();
  console.log("  погашен первый класс: отрезков", lanesBefore, "→", await page.locator(".ag-band-bar rect").count());
  await page.locator(".ag-band-chip").first().click();
  await page.getByRole("button", { name: "Участки в план" }).click();
  console.log("  участков в плане:", before, "→", await page.locator(".mag-cut-seg").count());
  await page.locator(".mag-cut-btn[aria-label='Закрыть']").click();
} else {
  console.log("нарезаемый ролик не разведан — полосу нарезки не проверяю");
}

// --- редактор ролика: разведка вместо треков ------------------------------ //
await page.getByRole("button", { name: /^Видео/ }).click();
await page.getByRole("button", { name: "Размечать" }).first().click();
await page.waitForSelector(".vt-timeline", { timeout: 60000 });
await page.waitForTimeout(1500);
const lanes = () => page.evaluate(() => ({
  разведка: document.querySelectorAll(".vt-scout").length,
  треков: document.querySelectorAll(".vt-row:not(.vt-scout)").length,
  полоса_px: (() => { const t = document.querySelector(".vt-timeline"); return t.offsetWidth - t.clientWidth; })(),
}));
console.log("редактор, разведка выключена:", JSON.stringify(await lanes()));
const scoutToggle = page.locator(".mag-ved-transport").getByRole("button", { name: "Разведка", exact: true });
if (await scoutToggle.count()) {
  await scoutToggle.click();
  await page.waitForSelector(".vt-scout", { timeout: 10000 });
  console.log("кнопкой включена:", JSON.stringify(await lanes()));
  await page.keyboard.press("r");
  await page.waitForTimeout(300);
  console.log("клавишей R выключена:", JSON.stringify(await lanes()));
} else {
  console.log("у первого размечаемого ролика разведка без находок — кнопки нет");
}
await browser.close();
