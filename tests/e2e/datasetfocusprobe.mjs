/** Проба «таска из датасета» и «Фокус» в датасете (решения 14.10.2026). Считает, а не смотрит:
 *  метки плиток, выбор и полоса «В таску», окно с плашкой, карточка «Из датасета», «Фокус» датасета
 *  (шапка, сведения, окна E и X, кадр в таске — только чтение), копия в таске: «Принять и далее».
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

try {
  await page.goto(BASE + "/");
  const st = await page.evaluate(async ([identity, password]) => (await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity, password }),
  })).status, [d.login, d.password]);
  if (st !== 200) throw new Error(`вход: ${st}`);

  // 1. Галерея: метки плиток и полоса «Отбор»
  await page.goto(`${BASE}/projects/${d.code}/datasets`);
  await until(async () => (await page.locator(".fr-tile").count()) === 6, 15000);
  check("плиток 6", (await page.locator(".fr-tile").count()) === 6, await page.locator(".fr-tile").count());
  check("кадр в таске подписан её именем", (await text(".fr-tile.held .fr-held")) === "Держит", await text(".fr-tile.held .fr-held"));
  check("флажок кадра в таске погашен", await page.locator(".fr-tile.held .fr-sel").isDisabled());
  check("кадр на проверке отмечен", (await text(".fr-tile.agent .fr-agt")) === "1", await text(".fr-tile.agent .fr-agt"));
  check("полоса «Отбор · 6 кадров»", (await text(".fr-take-bar")).startsWith("Отбор · 6 кадров"), await text(".fr-take-bar"));

  // 2. Выбор: щелчок по флажку, Shift — диапазон
  const tiles = page.locator(".fr-tile");
  await tiles.nth(0).hover();
  await tiles.nth(0).locator(".fr-sel").click();
  await tiles.nth(2).locator(".fr-sel").click({ modifiers: ["Shift"] });
  check("Shift выбрал диапазон из трёх", (await page.locator(".fr-tile.on").count()) === 3, await page.locator(".fr-tile.on").count());
  check("полоса «Выбрано 3»", (await text(".fr-take-bar")).startsWith("Выбрано 3"), await text(".fr-take-bar"));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300); // флажки проявляются за .12 с
  const visibleBoxes = await page.locator(".fr-tile:not(.on) .fr-sel").evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity));
  check("при выборе флажки видны на всех плитках", visibleBoxes.every((o) => o === "1"), visibleBoxes);
  await page.screenshot({ path: `${OUT}/dsf-select.png` });

  // Смена отбора выбор не сбрасывает: «На проверке» оставляет один невыбранный кадр
  await page.getByRole("button", { name: /На проверке/ }).click();
  await until(async () => (await page.locator(".fr-tile").count()) === 1);
  await until(async () => (await text(".fr-take-bar")).includes("не видно"));
  check("выбор пережил смену отбора, «не видно 3»", (await text(".fr-take-bar")).includes("Выбрано 3 из них не видно 3"), await text(".fr-take-bar"));
  await page.getByRole("button", { name: /На проверке/ }).click();
  await until(async () => (await page.locator(".fr-tile").count()) === 6);

  // Флажок группы: все свободные кадры группы (кадр в таске не выбирается)
  await page.locator(".fr-gsel").first().click();
  await until(async () => (await page.locator(".fr-tile.on").count()) === 5);
  check("флажок группы выбрал все свободные", (await page.locator(".fr-tile.on").count()) === 5, await page.locator(".fr-tile.on").count());
  check("флажок группы — «все»", (await page.locator(".fr-gsel.on").count()) === 1);
  await page.locator(".fr-gsel").first().click();
  await until(async () => (await page.locator(".fr-tile.on").count()) === 0);
  check("второй щелчок снял группу", (await page.locator(".fr-tile.on").count()) === 0);

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
  check("рамкой не нарисовать", await page.getByRole("button", { name: /^Рамка/ }).isDisabled());
  check("внизу только листание", !(await text("[aria-label='Решение по кадру']")).includes("Удалить из датасета"), await text("[aria-label='Решение по кадру']"));
  await page.screenshot({ path: `${OUT}/dsf-held.png` });

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
