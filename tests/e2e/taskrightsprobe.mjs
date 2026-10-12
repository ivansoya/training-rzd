/** Проба совместной работы в таске (решение 12.10.2026): два человека, два окна.
 *  Считает, а не смотрит: через сколько мс правка соседа на экране, что написано у записи,
 *  ушёл ли снятый исполнитель в просмотр. Данные готовит taskrightsprobe.py (всё с приставкой test-).
 *  docker exec -w /work/tests/e2e -e NODE_PATH=/opt/e2e/node_modules yolo-tests node taskrightsprobe.mjs */
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = "/work/tests/e2e/test-results";
const d = JSON.parse(execFileSync("python3", ["taskrightsprobe.py"], { encoding: "utf8" }).trim().split("\n").pop());
const browser = await chromium.launch();
const errors = [];

async function open(login) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("pageerror", (e) => errors.push(`${login}: ${e.message}`));
  await page.goto(BASE + "/");
  const st = await page.evaluate(async ([identity, password]) => (await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity, password }),
  })).status, [login, d.password]);
  if (st !== 200) throw new Error(`вход ${login}: ${st}`);
  return page;
}

const anna = await open(d.admin);
const petr = await open(d.petr);
const frameUrl = `${BASE}/projects/${d.code}/tasks/${d.task}?frame=${d.image}`;
await Promise.all([anna.goto(frameUrl), petr.goto(frameUrl)]);
await Promise.all([anna.waitForSelector(".mag-cv-frame"), petr.waitForSelector(".mag-cv-frame")]).catch(async (e) => {
  await anna.screenshot({ path: `${OUT}/rights-fail.png` });
  console.log("не открылся редактор:", e.message.split("\n")[0], "· ошибки:", errors, "· адрес:", anna.url());
  console.log((await anna.locator("body").innerText()).slice(0, 600));
  process.exit(1);
});
await anna.waitForTimeout(1500); // живая связь успевает поздороваться
const boxes = (p) => p.locator("rect.mag-cv-hit").count();
// waitForFunction страница не пускает (CSP без unsafe-eval) — ждём опросом локаторов; null — не дождались
async function until(ok, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await ok()) return Date.now() - t;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
console.log("рамок у Анны до:", await boxes(anna));

// 1. Пётр сохраняет кадр тем же запросом, что его редактор
const t0 = Date.now();
const put = await petr.evaluate(async ([image, ci]) => (await fetch(`/api/images/${image}/annotations`, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ boxes: [{ class_index: ci, x: 60, y: 40, w: 160, h: 90 }] }),
})).status, [d.image, d.class_index]);
const seen = await until(async () => (await boxes(anna)) === 1);
console.log("запись Петра:", put, "· у Анны рамок:", await boxes(anna), "· дождались за", seen, "мс (с записью", Date.now() - t0, ")");
console.log("строка у записи Анны:", await anna.locator(".ed-save").innerText());
await anna.screenshot({ path: `${OUT}/rights-live.png` });

// 2. Анна снимает Петра с таски через паспорт; редактор Петра должен уйти в просмотр
const skipBefore = await petr.getByRole("button", { name: /Отложить/ }).count();
await anna.goto(`${BASE}/projects/${d.code}/tasks/${d.task}`);
await anna.waitForSelector(".tm-edit");
await anna.locator(".tm-edit").click();
await anna.locator(".tm-pop").getByRole("button", { name: "Пётр Проба" }).click();
await anna.screenshot({ path: `${OUT}/rights-team.png` });
await anna.locator(".tm-pop").getByRole("button", { name: "Сохранить" }).click();
const gone = await until(async () => (await petr.getByRole("button", { name: /Отложить/ }).count()) === 0);
console.log("«Отложить» у Петра до/после:", skipBefore, await petr.getByRole("button", { name: /Отложить/ }).count(),
  "· ушёл в просмотр за", gone, "мс");
await petr.screenshot({ path: `${OUT}/rights-petr-ro.png` });
await anna.waitForTimeout(800);
console.log("исполнители в паспорте:", (await anna.locator(".tm-edit").innerText()).replace(/\s+/g, " "));
await anna.getByRole("button", { name: "Вся история" }).click();
await anna.waitForTimeout(500);
console.log("история:", (await anna.locator(".tp-feed").last().innerText()).split("\n").filter((l) => /Исполнители|создана/.test(l)));
await anna.screenshot({ path: `${OUT}/rights-history.png` });
await anna.keyboard.press("Escape");

// 3. Пётр на странице таски: ничего не может, кнопок нет
await petr.goto(`${BASE}/projects/${d.code}/tasks/${d.task}`);
await petr.waitForSelector(".tp-two");
await petr.waitForTimeout(800);
console.log("у Петра главная кнопка:", await petr.locator(".ui-ph-a .ui-btn").last().innerText(),
  "· «Добавить»:", await petr.getByRole("button", { name: "Добавить" }).count(),
  "· «Готово»:", await petr.getByRole("button", { name: "Готово" }).count());
await petr.screenshot({ path: `${OUT}/rights-petr.png`, fullPage: true });

// 4. Доска глазами Анны
await anna.goto(`${BASE}/projects/${d.code}/tasks`);
await anna.waitForSelector(".tb-card");
await anna.waitForTimeout(600);
console.log("карточка:", (await anna.locator(".tb-card").first().innerText()).replace(/\s+/g, " "));
await anna.screenshot({ path: `${OUT}/rights-board.png` });

// 5. Окно «Новая таска» у админа: чипы людей, по умолчанию — сам
await anna.getByRole("button", { name: "Новая таска" }).click();
await anna.waitForSelector(".tm-pick");
console.log("окно создания, нажаты:", await anna.locator(".tm-pick [aria-pressed=true]").allInnerTexts());
await anna.screenshot({ path: `${OUT}/rights-create.png` });
await anna.keyboard.press("Escape");

// 6. Ничью таску с очереди Пётр берёт кнопкой на странице и становится исполнителем
const pool = await anna.evaluate(async (code) => (await (await fetch(`/api/projects/${code}/tasks`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ничья", assignees: [] }),
})).json()).id, d.code);
await petr.goto(`${BASE}/projects/${d.code}/tasks/${pool}`);
await petr.waitForSelector(".tp-two");
await petr.getByRole("button", { name: "Взять в работу" }).click();
await until(async () => (await petr.locator(".tp-kv").innerText()).includes("Пётр Проба"));
console.log("ничья после «Взять в работу»:", (await petr.locator(".tp-state").innerText()).replace(/\s+/g, " "),
  "· исполнители:", (await petr.locator(".tp-kv dd").first().innerText()).replace(/\s+/g, " "));

console.log("ошибки:", errors.length ? errors : "нет");
await browser.close();
