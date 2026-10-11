/** «Оборудование» глазами tester: таблица карт, очередь справа, счётчик на рельсе, одна полоса на обзоре
 *  проекта и блок «Видеокарты» в окне обучения (решения 10.10.2026). Проба считает, а не смотрит: строк
 *  карт — сколько отдаёт /api/gpu, очередь справа от карт на широком окне и под ними на узком, число на
 *  рельсе — свои задачи в очереди. Ничего не меняет, кроме поиска в карточке «Доступ» (без выдачи);
 *  ⚠ с TOGGLE=1 щёлкает тумблер SAM 3 на сервере.
 *
 *   docker exec -w /work/tests/e2e -e TAG=one -e PASS=123456 -e PROJECT=<код> -e NODE_PATH=/opt/e2e/node_modules yolo-tests node hwprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const TAG = process.env.TAG || "x";
const PROJECT = process.env.PROJECT || "";

const bad = [];
const check = (ok, what) => { console.log(`[${TAG}] ${ok ? "OK  " : "FAIL"} ${what}`); if (!ok) bad.push(what); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => bad.push(`ошибка страницы: ${e.message}`));
await page.goto(BASE + "/");
await page.evaluate((pass) => fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: pass }) }), process.env.PASS || "VniiTest");
const api = await page.evaluate(() => fetch("/api/gpu").then((r) => r.json()));
await page.goto(`${BASE}/hardware`);
await page.waitForSelector(".hw .hw-tbl, .hw .ui-empty", { timeout: 20000 });
await page.waitForTimeout(900);
const text = async (sel) => (await page.locator(sel).first().innerText().catch(() => "—")).replace(/\s+/g, " ");
const box = (sel) => page.locator(sel).first().boundingBox();
console.log(`[${TAG}] шапка:`, await text(".hw .ui-ph"));
console.log(`[${TAG}] сводка:`, await text(".hw-total"));
console.log(`[${TAG}] карты:`, await text(".hw-cards"));
console.log(`[${TAG}] очередь:`, await text(".hw-q"));

const many = api.devices.length > 1;
check(await page.locator(".hw-dev").count() === api.devices.length, `строк карт столько же, сколько карт в /api/gpu (${api.devices.length})`);
check(await page.locator(".hw-total").count() === (many ? 1 : 0), many ? "сводка над таблицей есть" : "сводки при одной карте нет");
if (!many) {
  check(await page.locator(".hw-det").count() === 1, "одна карта раскрыта сразу");
} else {
  // Живая карта, а не выключенный двойник: на снимке нужны держатели и метка «карты 0–1».
  const row = page.locator(".hw-dev:not(.off)").first();
  check(await page.locator(".hw-det").count() === 0, "карты свёрнуты");
  await row.click();
  check(await page.locator(".hw-det").count() === 1, "щелчок по строке раскрыл карту");
  await row.press("Enter");
  check(await page.locator(".hw-det").count() === 0, "Enter свернул её обратно");
  await row.click();
  const multi = api.devices.flatMap((d) => d.holders).filter((h) => h.cards && h.cards.length > 1).length;
  if (multi) check(await page.locator(".hw-det .hw-multi").count() > 0, "у задачи на нескольких картах — метка «карты …»");
}
let cards = await box(".hw-cards"), queue = await box(".hw-q");
check(queue.x >= cards.x + cards.width - 1 && Math.abs(queue.y - cards.y) < 2, "на 1440 очередь справа от карт");
await page.setViewportSize({ width: 900, height: 1000 });
await page.waitForTimeout(300);
cards = await box(".hw-cards"); queue = await box(".hw-q");
check(queue.y >= cards.y + cards.height - 1, "на 900 очередь под картами");
await page.screenshot({ path: `${OUT}/hw-${TAG}-900.png`, fullPage: true });
await page.setViewportSize({ width: 1440, height: 1000 });

const mine = api.queue.mine.length;
const counter = await page.locator(".sb-q").count() ? Number(await text(".sb-q")) : 0;
check(counter === mine, `на рельсе ${counter} — своих задач в очереди ${mine}`);
check(await page.locator(".sb-gpu").count() === 0, "карт в рельсе нет");
const cursor = await page.locator(".hw-dev").first().evaluate((el) => getComputedStyle(el).cursor);
check(cursor === (many ? "pointer" : "default"), `курсор над строкой карты: ${cursor}`);

if (await page.locator(".hw-acc").count()) {
  await page.getByLabel("Найти человека").fill("qa-ux");
  await page.waitForTimeout(800);
  console.log(`[${TAG}] доступ:`, await text(".hw-acc"));
}
console.log(`[${TAG}] модели:`, await text(".hw-models"));
if (process.env.TOGGLE && await page.getByRole("switch", { name: "SAM 3: ужимать до переноса на карту" }).count()) {
  await page.getByRole("switch", { name: "SAM 3: ужимать до переноса на карту" }).click();
  await page.waitForTimeout(1200);
  console.log(`[${TAG}] после щелчка:`, await text(".hw-models"));
}
await page.locator(".hw-models").screenshot({ path: `${OUT}/hw-${TAG}-models.png` }).catch(() => undefined);
await page.screenshot({ path: `${OUT}/hw-${TAG}.png`, fullPage: true });

if (PROJECT) {
  await page.goto(`${BASE}/projects/${PROJECT}`);
  await page.waitForSelector(".ov-gpu", { timeout: 20000 });
  check(await page.locator(".ov-gpu .ui-stack").count() === 1, "на обзоре одна полоса на все карты");
  console.log(`[${TAG}] обзор:`, await text(".ov-gpu"));
  await page.locator(".ov-gpu").screenshot({ path: `${OUT}/hw-${TAG}-overview.png` }).catch(() => undefined);

  await page.goto(`${BASE}/projects/${PROJECT}/runs`);
  await page.getByRole("button", { name: "Новое обучение" }).first().click();
  await page.waitForSelector(".rn-form", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const block = page.locator(".rn-gpu");
  check(await block.count() === (api.cards.length > 1 ? 1 : 0), `блок «Видеокарты» ${api.cards.length > 1 ? "есть" : "скрыт"} при ${api.cards.length} живых картах`);
  if (api.cards.length > 1) {
    await page.getByRole("group", { name: "Карт на обучение" }).getByRole("button", { name: "2" }).click();
    await page.waitForTimeout(900);
    const line = await text(".rn-gpu-l");
    console.log(`[${TAG}] видеокарты:`, line);
    check(/по \d+ на карту/.test(line) && /ГБ на карту/.test(line), "строка «батч — по N на карту · ≈ X ГБ на карту»");
    await page.locator(".rn-form-g").filter({ hasText: "Видеокарты" }).screenshot({ path: `${OUT}/hw-${TAG}-run.png` }).catch(() => undefined);
  }
}
await browser.close();
console.log(bad.length ? `\nПРОВАЛЫ:\n  ${bad.join("\n  ")}` : "\nвсё зелёное");
process.exit(bad.length ? 1 : 0);
