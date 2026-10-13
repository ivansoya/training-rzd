/** Обзор проекта глазами tester: карточки «Таски» (строки, решение 13.10.2026) и «Видеокарта» (цвет по загрузке).
 *  Проба считает: строки одной высоты и с линией между ними, бейджей нет, заготовка той же высоты, что итог,
 *  легенда — только при полосе; метка карты совпадает с подсчётом по /api/gpu. Ничего не меняет.
 *
 *   docker exec -w /work/tests/e2e -e PASS=123456 -e PROJECTS=<код>,<код> -e NODE_PATH=/opt/e2e/node_modules yolo-tests node overviewprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const PROJECTS = (process.env.PROJECTS || "").split(",").filter(Boolean);

const bad = [];
let tag = "";
const check = (ok, what) => { console.log(`[${tag}] ${ok ? "OK  " : "FAIL"} ${what}`); if (!ok) bad.push(`${tag}: ${what}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.on("pageerror", (e) => bad.push(`ошибка страницы: ${e.message}`));
await page.goto(BASE + "/");
await page.evaluate((pass) => fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: pass }) }), process.env.PASS || "VniiTest");

// Счётчики задерживаем: иначе на стенде они приходят раньше замера, и заготовку не увидеть
await page.route("**/api/tasks/*/summary", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });

const tasksCard = "section.ui-card:has(.ov-tasks)";
const gpuCard = "section.ui-card:has(.ov-gpu)";

for (const code of PROJECTS) {
  tag = code.slice(0, 6);
  // Без кеша: первая отрисовка — заготовки, по ним и мерим высоту
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/projects/${code}`);
  await page.waitForSelector(".ov-tasks li", { timeout: 20000 });
  const before = (await page.locator(".ov-tasks").boundingBox()).height;
  const skeletons = await page.locator(".ov-tasks .ui-sk").count();
  // Ждём, пока все числа придут: заготовок не осталось
  check(skeletons > 0, `на первой отрисовке заготовки (${skeletons})`);
  for (let i = 0; i < 60 && await page.locator(".ov-tasks .ui-sk").count() > 0; i++) await page.waitForTimeout(250);
  const after = (await page.locator(".ov-tasks").boundingBox()).height;
  console.log(`[${tag}] заготовок было ${skeletons}, высота списка ${before} → ${after}`);
  check(await page.locator(".ov-tasks .ui-sk").count() === 0, "все числа пришли");
  check(Math.abs(before - after) < 1, "высота списка не прыгнула после загрузки");

  const rows = await page.locator(".ov-tasks li").evaluateAll((lis) => lis.map((li) => {
    const r = li.getBoundingClientRect(), cs = getComputedStyle(li);
    const inner = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
    return { inner, border: cs.borderBottomWidth, text: li.innerText.replace(/\s+/g, " ") };
  }));
  rows.forEach((r) => console.log(`[${tag}]   ${r.text}`));
  check(rows.length > 0 && rows.length <= 4, `строк ${rows.length} (не больше четырёх)`);
  check(new Set(rows.map((r) => Math.round(r.inner))).size === 1, `строки одной высоты (${rows.map((r) => Math.round(r.inner)).join(", ")})`);
  check(rows.slice(0, -1).every((r) => r.border === "1px") && rows.at(-1).border === "0px", "линия между тасками, у последней нет");
  check(await page.locator(`${tasksCard} .ui-badge`).count() === 0, "бейджей состояния нет");
  check(rows.every((r) => !/0 из 0/.test(r.text)), "нигде нет «0 из 0»");
  check(await page.locator(".ov-tasks li > .ui-dot").count() === rows.length, "у каждой таски точка состояния");
  const bars = await page.locator(".ov-task-p .ui-stack").count();
  const legend = await page.locator(`${tasksCard} .ui-legend`).count();
  check((bars > 0) === (legend > 0), `легенда ${legend ? "есть" : "нет"} при полосах: ${bars}`);
  await page.locator(tasksCard).screenshot({ path: `${OUT}/overview-${tag}-tasks.png` });

  if (await page.waitForSelector(".ov-gpu", { timeout: 15000 }).then(() => true, () => false)) {
    const api = await page.evaluate(() => fetch("/api/gpu").then((r) => r.json()));
    const live = api.devices.filter((d) => d.enabled && d.fresh);
    const share = live.reduce((s, d) => s + d.free_mb, 0) / live.reduce((s, d) => s + d.total_mb, 0);
    const want = share >= 0.3 ? "свободна" : share >= 0.1 ? "загружена" : "занята";
    const label = (await page.locator(`${gpuCard} .ui-card-a .ui-badge`).innerText()).trim();
    check(label === want, `метка карты «${label}», по /api/gpu свободно ${Math.round(share * 100)} % → «${want}»`);
    // Свободная доля — последняя в полосе; у «свободна» в ней больше зелёного, чем красного и синего
    const rgb = await page.locator(`${gpuCard} .ui-stack > i`).last().evaluate((el) => getComputedStyle(el).backgroundColor);
    console.log(`[${tag}] цвет свободного: ${rgb}`);
    const [r, g, b] = rgb.match(/[\d.]+/g).map(Number);
    if (want === "свободна") check(g > r && g > b, "свободное — зелёное");
    await page.locator(gpuCard).screenshot({ path: `${OUT}/overview-${tag}-gpu.png` });
  } else {
    console.log(`[${tag}] карточки видеокарты нет (карт нет на стенде)`);
  }
}

await browser.close();
console.log(bad.length ? `\nПРОВАЛЫ:\n- ${bad.join("\n- ")}` : "\nвсё сошлось");
process.exit(bad.length ? 1 : 0);
