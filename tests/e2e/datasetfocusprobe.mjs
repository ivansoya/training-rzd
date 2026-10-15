/** Проба «таска из датасета» и «Фокус» в датасете (решения 14–15.10.2026). Считает, а не смотрит:
 *  метки плиток, отбор как в Фото (вход флажком и из «⋯», выход со снятием последнего, метки флажков
 *  по центру по пикселям), полоса «В таску», окно с плашкой, карточка «Из датасета», «Фокус» датасета
 *  (просмотр и «Править», сведения, окна E и X, кадр в таске — только чтение), копия в таске: «Принять и далее».
 *  Данные — datasetfocusprobe.py (проект test-…, в конце удаляется).
 *  docker exec -w /work/tests/e2e -e NODE_PATH=/opt/e2e/node_modules -e BASE=http://localhost:8097 yolo-tests node datasetfocusprobe.mjs */
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = "/work/tests/e2e/test-results";
const d = JSON.parse(execFileSync("python3", ["datasetfocusprobe.py"], { encoding: "utf8" }).trim().split("\n").pop());
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fails = [];
const check = (name, ok, got) => {
  console.log(`${ok ? "ок " : "НЕТ"} ${name}${got !== undefined ? ` — ${JSON.stringify(got)}` : ""}`);
  if (!ok) fails.push(name);
};
async function until(ok, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await ok()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}
const text = async (sel) => ((await page.locator(sel).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
// Метка флажка по пикселям снимка: от центра метки наружу — сколько пикселей поля до рамки с каждой стороны;
// dx/dy — перекос. По осям через центр, чтобы фон за скруглёнными углами в замер не попадал
async function centered(loc) {
  const png = (await loc.screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const im = new Image();
    im.src = `data:image/png;base64,${b64}`;
    await im.decode();
    const W = im.width, H = im.height;
    const cv = Object.assign(document.createElement("canvas"), { width: W, height: H });
    const g = cv.getContext("2d");
    g.drawImage(im, 0, 0);
    const px = g.getImageData(0, 0, W, H).data;
    const lum = (x, y) => { const i = (y * W + x) * 4; return (px[i] + px[i + 1] + px[i + 2]) / 3; };
    const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
    const cx = W >> 1, cy = H >> 1;
    const run = (sx, sy) => {
      let x = cx, y = cy;
      while (inside(x, y) && lum(x, y) > 200) { x += sx; y += sy; }
      const field = inside(x, y) ? lum(x, y) : 0;
      let n = 0;
      while (inside(x, y) && Math.abs(lum(x, y) - field) < 25) { n++; x += sx; y += sy; }
      return n;
    };
    const l = run(-1, 0), r = run(1, 0), t = run(0, -1), b = run(0, 1);
    return { hit: lum(cx, cy) > 200, l, r, t, b, dx: l - r, dy: t - b };
  }, png);
}

try {
  await page.goto(BASE + "/");
  const st = await page.evaluate(async ([identity, password]) => (await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity, password }),
  })).status, [d.login, d.password]);
  if (st !== 200) throw new Error(`вход: ${st}`);

  // 1. Галерея: метки плиток; полосы до отбора нет (решение 15.10.2026)
  await page.goto(`${BASE}/projects/${d.code}/datasets`);
  await until(async () => (await page.locator(".fr-tile").count()) === 6, 15000);
  check("плиток 6", (await page.locator(".fr-tile").count()) === 6, await page.locator(".fr-tile").count());
  check("кадр в таске подписан её именем", (await text(".fr-tile.held .fr-held")) === "Держит", await text(".fr-tile.held .fr-held"));
  check("флажок кадра в таске погашен", await page.locator(".fr-tile.held .fr-sel").isDisabled());
  check("кадр на проверке отмечен", (await text(".fr-tile.agent .fr-agt")) === "1", await text(".fr-tile.agent .fr-agt"));
  check("полосы при входе нет", (await page.locator(".fr-take-bar").count()) === 0);

  // 2. Отбор как в Фото: флажок включает режим, дальше щелчок по плитке выбирает, Shift — диапазон
  const tiles = page.locator(".fr-tile");
  const on = () => page.locator(".fr-tile.on").count();
  await tiles.nth(0).hover();
  await tiles.nth(0).locator(".fr-sel").click();
  check("флажок включил отбор: «Отбор · Источник», выбрано 1",
    (await text(".fr-take-bar")).includes("Отбор · Источник") && (await text(".fr-take-bar")).includes("выбрано 1"), await text(".fr-take-bar"));
  await tiles.nth(2).locator(".fr-open").click({ modifiers: ["Shift"] });
  check("Shift-щелчок по плитке выбрал диапазон из трёх", (await on()) === 3, await on());
  check("в отборе кадр не открывается", (await page.locator(".ed.fe").count()) === 0);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300); // флажки проявляются за .12 с
  const visibleBoxes = await page.locator(".fr-tile:not(.on) .fr-sel").evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity));
  check("в отборе флажки видны на всех плитках", visibleBoxes.every((o) => o === "1"), visibleBoxes);
  const look = await page.locator(".fr-tile.on").first().evaluate((el) => ({
    img: getComputedStyle(el.querySelector(".fr-open > img")).filter, ring: getComputedStyle(el, "::before").boxShadow,
    top: getComputedStyle(el, "::before").zIndex }));
  check("выбранный затемнён и в рамке поверх кадра", look.img.startsWith("brightness") && look.ring.includes("inset") && look.top === "1", look);
  const mark = await centered(page.locator(".fr-tile.on .fr-sel i").first());
  check("метка флажка по центру", mark.hit && mark.dx === 0 && mark.dy === 0, mark);
  const box = await page.locator(".fr-tile.on").first().evaluate((el) => {
    const t = el.getBoundingClientRect(), c = el.querySelector(".fr-sel i").getBoundingClientRect();
    return { left: c.left - t.left, top: c.top - t.top };
  });
  check("флажок в 6 px от угла, как метки справа", box.left === 6 && box.top === 6, box);
  await page.screenshot({ path: `${OUT}/dsf-select.png` });
  await tiles.nth(2).locator(".fr-open").click();
  check("повторный щелчок снял кадр", (await on()) === 2, await on());

  // Смена отбора выбор не сбрасывает: «На проверке» оставляет один невыбранный кадр
  await page.getByRole("button", { name: /На проверке/ }).click();
  await until(async () => (await page.locator(".fr-tile").count()) === 1);
  await until(async () => (await text(".fr-take-bar")).includes("не видно"));
  check("выбор пережил смену отбора, «не видно 2»", (await text(".fr-take-bar")).includes("выбрано 2 из них не видно 2"), await text(".fr-take-bar"));
  await page.getByRole("button", { name: /На проверке/ }).click();
  await until(async () => (await page.locator(".fr-tile").count()) === 6);

  // Флажок группы: при выборе снимает всё, и отбор выключается
  await page.locator(".fr-gsel").first().click();
  await until(async () => (await on()) === 0);
  check("флажок группы снял весь выбор", (await on()) === 0, await on());
  check("снят последний — отбора нет, полосы нет", (await page.locator(".fr-take-bar").count()) === 0);
  // Без выбора — все свободные кадры группы (кадр в таске не выбирается)
  await page.locator(".fr-gsel").first().click();
  await until(async () => (await on()) === 5);
  check("флажок группы выбрал все свободные", (await on()) === 5, await on());
  check("флажок группы — «все»", (await page.locator(".fr-gsel.on").count()) === 1);
  const gmark = await centered(page.locator(".fr-gsel.on i"));
  check("метка флажка группы по центру", gmark.hit && gmark.dx === 0 && gmark.dy === 0, gmark);
  await page.locator(".fr-gsel").first().click();
  await until(async () => (await on()) === 0);
  check("второй щелчок снял группу и выключил отбор", (await on()) === 0 && (await page.locator(".fr-take-bar").count()) === 0);

  // «Включить отбор» из «⋯»: пустой режим держится до первого выбора
  await page.getByRole("button", { name: "Действия с группой" }).click();
  await page.locator(".ui-pop").getByRole("button", { name: "Включить отбор" }).click();
  await until(async () => (await page.locator(".fr-take-bar").count()) === 1);
  check("пустой отбор: «выбрано 0», «В таску» погашена", (await text(".fr-take-bar")).includes("выбрано 0")
    && await page.locator(".fr-take-bar").getByRole("button", { name: /В таску/ }).isDisabled(), await text(".fr-take-bar"));
  await tiles.nth(0).locator(".fr-open").click();
  check("щелчок по плитке выбрал", (await on()) === 1, await on());
  await tiles.nth(0).locator(".fr-open").click();
  await until(async () => (await page.locator(".fr-take-bar").count()) === 0);
  check("снят последний — отбор выключился", (await page.locator(".fr-take-bar").count()) === 0);
  await tiles.nth(0).locator(".fr-open").click();
  await until(async () => (await page.locator(".ed.fe").count()) === 1);
  check("без отбора щелчок открывает «Фокус»", (await page.locator(".ed.fe").count()) === 1);
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".ed.fe").count()) === 0);

  // 3. «В таску ▾»: меню и окно новой таски с плашкой
  await tiles.nth(0).hover();
  await tiles.nth(0).locator(".fr-sel").click();
  await tiles.nth(1).locator(".fr-sel").click();
  await page.locator(".fr-take-bar").getByRole("button", { name: /В таску/ }).click();
  await until(async () => (await page.locator(".ui-pop").getByRole("button", { name: "Держит" }).count()) > 0);
  check("в меню — открытая таска «Держит»", (await page.locator(".ui-pop").getByRole("button", { name: "Держит" }).count()) === 1);
  check("в меню нет сданной «Источник»", (await page.locator(".ui-pop").getByRole("button", { name: "Источник" }).count()) === 0);
  await page.screenshot({ path: `${OUT}/dsf-menu.png` });
  await page.locator(".ui-pop").getByRole("button", { name: /Новая таска/ }).click();
  await until(async () => (await text(".ct-from-h")).includes("Из датасета: 2 кадра"));
  check("плашка «Из датасета: 2 кадра»", (await text(".ct-from-h")).includes("Из датасета: 2 кадра"), await text(".ct-from-h"));
  check("плашка называет датасет", (await text(".ct-from")).includes("Источник · 2"), await text(".ct-from"));
  await page.getByLabel("Название").fill("Проверка копий");
  await page.screenshot({ path: `${OUT}/dsf-dialog.png` });
  await page.getByRole("button", { name: "Создать таску" }).click();
  await until(async () => /\/tasks\//.test(page.url()));
  const taskId = page.url().split("/tasks/")[1].split(/[?#]/)[0];
  await until(async () => (await page.locator(".tp-src").filter({ hasText: "Из датасета" }).count()) > 0, 10000);
  const card = page.locator(".tp-src").filter({ hasText: "Из датасета" });
  check("на странице таски карточка «Из датасета»", (await card.count()) === 1);
  await until(async () => (await card.innerText()).includes("При сдаче"));
  check("карточка: «При сдаче … не тронем 2»", (await card.innerText()).replace(/\s+/g, " ").includes("не тронем 2"),
    (await card.innerText()).replace(/\s+/g, " ").slice(0, 200));
  await page.screenshot({ path: `${OUT}/dsf-task.png` });

  // 4. Копия в таске: «Принять и далее» отмечает нетронутую копию
  await page.evaluate(async (id) => fetch(`/api/tasks/${id}/status`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "in_progress" }),
  }), taskId);
  await page.reload();
  await until(async () => (await page.locator(".tp-src").filter({ hasText: "Из датасета" }).getByRole("button", { name: "Размечать" }).count()) > 0, 10000);
  await page.locator(".tp-src").filter({ hasText: "Из датасета" }).getByRole("button", { name: "Размечать" }).click();
  await page.waitForSelector(".ed.fe");
  await until(async () => (await text("[aria-label='Решение по кадру']")).includes("Принять и далее"));
  check("у нетронутой копии — «Принять и далее»", (await text("[aria-label='Решение по кадру']")).includes("Принять и далее"), await text("[aria-label='Решение по кадру']"));
  check("в блоке «Кадр» — исходник", (await text(".fe-info")).includes("Исходник Источник"), await text(".fe-info"));
  await page.screenshot({ path: `${OUT}/dsf-copy.png` });
  await page.keyboard.press("Space");
  const marked = await until(async () => {
    const r = await page.evaluate(async (id) => (await (await fetch(`/api/tasks/${id}/counts`)).json()).counts, taskId);
    return r.annotated === 1;
  });
  check("Пробел принял копию как есть (размечено 1)", marked);
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".ed.fe").count()) === 0);

  // 5. «Фокус» датасета — на свободном кадре 3 (кадры 1–2 теперь копиями в «Проверка копий», 5 — в «Держит»)
  await page.goto(`${BASE}/projects/${d.code}/datasets`);
  await until(async () => (await page.locator(".fr-tile").count()) === 6, 15000);
  check("кадры, ушедшие в таску, на плитках подписаны", (await page.locator(".fr-tile.held").count()) === 3, await page.locator(".fr-tile.held").count());
  await page.locator(".fr-tile").nth(2).locator(".fr-open").click();
  await page.waitForSelector(".ed.fe");
  await until(async () => (await text(".ed-title")).includes("Кадр 3 из 6"));
  check("шапка: группа и «Кадр 3 из 6»", (await text(".ed-title")).startsWith("Источник") && (await text(".ed-title")).includes("Кадр 3 из 6"), await text(".ed-title"));
  check("назад — к датасетам", (await page.getByRole("button", { name: "К датасетам (Esc)" }).count()) === 1);
  check("прогресса таски нет", (await page.locator(".ed-prog").count()) === 0);
  check("сведения о кадре", (await text(".fe-info")).includes("Датасет Источник") && (await text(".fe-info")).includes("Из таски Источник"), await text(".fe-info"));
  check("«Скачать оригинал» есть", (await page.getByRole("link", { name: "Скачать оригинал" }).count()) === 1);
  // Открыт просмотром: правящее скрыто, клавиши правки молчат (решение 15.10.2026)
  check("в просмотре инструментов нет", (await page.locator(".ed-top").count()) === 0);
  check("в просмотре внизу только листание", !(await text("[aria-label='Решение по кадру']")).includes("Пусто"), await text("[aria-label='Решение по кадру']"));
  check("в просмотре таги без поля ввода", (await page.locator(".fe-side input").count()) === 0);
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(300);
  check("E в просмотре молчит", (await page.getByRole("dialog", { name: "Сделать кадр фоновым?" }).count()) === 0);
  await page.screenshot({ path: `${OUT}/dsf-view.png` });
  await page.getByRole("button", { name: "Править" }).click();
  check("«Править» показало инструменты", (await page.locator(".ed-top").count()) === 1);
  const bar = await text("[aria-label='Решение по кадру']");
  check("внизу «Пусто», «Удалить из датасета», без «Отложить»", bar.includes("Пусто") && bar.includes("Удалить из датасета") && !bar.includes("Отложить"), bar);
  check("кнопка агента G есть", (await page.getByRole("button", { name: /Агент на этом кадре/ }).count()) === 1);
  await page.screenshot({ path: `${OUT}/dsf-focus.png` });

  await page.keyboard.press("KeyE");
  await until(async () => (await page.getByRole("dialog", { name: "Сделать кадр фоновым?" }).count()) > 0);
  check("E спрашивает окном", (await page.getByRole("dialog", { name: "Сделать кадр фоновым?" }).count()) === 1);
  await page.getByRole("button", { name: "Отмена" }).click();
  await page.keyboard.press("KeyX");
  await until(async () => (await page.getByRole("dialog", { name: "Удалить кадр из датасета?" }).count()) > 0);
  const xText = await text("[role=dialog]:has-text('Удалить кадр из датасета?')");
  check("X: таска-происхождение жива — вернуть можно там", xText.includes("Вернуть его можно там"), xText.slice(0, 160));
  await page.screenshot({ path: `${OUT}/dsf-x.png` });
  await page.getByRole("button", { name: "Отмена" }).click();
  check("после «Отмена» рамка на месте", (await page.locator("rect.mag-cv-hit").count()) === 1, await page.locator("rect.mag-cv-hit").count());

  // Кадр в таске: только чтение, плашка ведёт в таску
  for (let i = 0; i < 2; i++) { await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(250); }
  await until(async () => (await text(".ed-notes")).includes("Проверка копий"));
  check("у кадра в таске плашка «В таске «Проверка копий»»", (await text(".ed-notes")).includes("В таске «Проверка копий»"), await text(".ed-notes"));
  check("у кадра в таске инструментов и «Править» нет", (await page.locator(".ed-top").count()) === 0
    && (await page.getByRole("button", { name: /^(Править|Готово)$/ }).count()) === 0);
  check("внизу только листание", !(await text("[aria-label='Решение по кадру']")).includes("Удалить из датасета"), await text("[aria-label='Решение по кадру']"));
  await page.screenshot({ path: `${OUT}/dsf-held.png` });
  // Правка держится при листании до закрытия; «Готово» возвращает просмотр
  for (let i = 0; i < 2; i++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(250); }
  await until(async () => (await text(".ed-title")).includes("Кадр 3 из 6"));
  check("вернулись на свободный — правка держится", (await page.locator(".ed-top").count()) === 1);
  await page.getByRole("button", { name: "Готово" }).click();
  check("«Готово» вернуло просмотр", (await page.locator(".ed-top").count()) === 0
    && (await page.getByRole("button", { name: "Править" }).count()) === 1);

  check("ошибок страницы нет", errors.length === 0, errors);
} catch (e) {
  fails.push(`исключение: ${e.message.split("\n")[0]}`);
  console.log("ИСКЛЮЧЕНИЕ", e.message);
  await page.screenshot({ path: `${OUT}/dsf-fail.png` }).catch(() => {});
} finally {
  await page.evaluate(async (code) => fetch(`/api/projects/${code}`, { method: "DELETE" }), d.code).catch(() => {});
  await browser.close();
  console.log(fails.length ? `НЕ СОШЛОСЬ: ${fails.join("; ")}` : "всё сошлось");
}
