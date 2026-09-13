/** Окно судьбы класса: числа в диалоге обязаны сойтись с числами сервера.
 *
 * Проба считает, а не смотрит. «Диалог показал разметки» — это «взял число из
 * `usage`, нашёл его в таблице окна и сравнил», иначе получился бы честный
 * сервер и врущее окно: ровно так до этой работы и было — цена бралась из
 * снимка страницы и разметку роликов не считала вовсе.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const LOGIN = "tester";
const PASSWORD = "123456";

const fails = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails.push(`${name}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
  console.log(`${ok ? "✓" : "✘"} ${name}: ${JSON.stringify(got)}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(BASE + "/");
const logged = await page.evaluate(async ([login, password]) => {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: login, password }),
  });
  return r.status;
}, [LOGIN, PASSWORD]);
check("вход", logged, 200);

// --- готовим проект: два класса и три бокса на одном кадре ------------------ #
const setup = await page.evaluate(async () => {
  const json = (path, body, method = "POST") =>
    fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  const tag = "test-fate-" + Math.random().toString(16).slice(2, 8);
  const project = await json("/api/projects", { name: tag, description: "проба" });
  const task = await json(`/api/projects/${project.code}/tasks`, { name: tag });
  await json(`/api/tasks/${task.id}/status`, { status: "in_progress" });

  const src = await json(`/api/projects/${project.code}/classes`, { name: "шпала" });
  const dst = await json(`/api/projects/${project.code}/classes`, { name: "рельс" });

  // Кадр рисуем сами: тащить файл в браузер ради одного изображения незачем.
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 200;
  canvas.getContext("2d").fillRect(0, 0, 400, 200);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg"));
  const form = new FormData();
  form.append("files", blob, "test-frame.jpg");
  await fetch(`/api/tasks/${task.id}/images`, { method: "POST", body: form });

  const listing = await (await fetch(`/api/tasks/${task.id}/images`)).json();
  const image = listing.images[0];
  await json(
    `/api/images/${image.id}/annotations`,
    {
      boxes: [
        { class_index: src.class_index, x: 10, y: 10, w: 40, h: 40 },
        { class_index: src.class_index, x: 100, y: 10, w: 40, h: 40 },
        { class_index: dst.class_index, x: 200, y: 10, w: 40, h: 40 },
      ],
    },
    "PUT"
  );

  const usage = await (await fetch(
    `/api/projects/${project.code}/classes/${src.id}/usage?target=${dst.id}`
  )).json();
  return { code: project.code, src, dst, usage };
});
console.log("проект:", setup.code);
check("сервер: разметок у «шпалы»", setup.usage.annotations, 2);
check("сервер: кадров с обоими классами", setup.usage.overlap_images, 1);

// --- открываем окно судьбы -------------------------------------------------- #
await page.goto(`${BASE}/projects/${setup.code}/classes`);
await page.waitForSelector(".mag-classes-table", { timeout: 15000 });

const rowOf = (name) =>
  page.locator(".mag-classes-table tr", { hasText: name }).first();
await rowOf("шпала").getByRole("button", { name: "Изменить" }).click();
await page.waitForSelector(".mag-modal-foot");
await page.getByRole("button", { name: "Удалить", exact: true }).click();
await page.waitForSelector(".mag-fate-table", { timeout: 15000 });

const shown = await page.$$eval(".mag-fate-table tr", (rows) =>
  Object.fromEntries(
    rows.map((tr) => [
      tr.cells[0].textContent.trim(),
      Number(tr.cells[1].textContent.replace(/\s/g, "")),
    ])
  )
);
check(
  "окно: разметок на кадрах = число сервера",
  shown["Разметок на кадрах"],
  setup.usage.annotations
);
check("окно: треков", shown["Треков в несданных роликах"], setup.usage.video_tracks);
check("окно: ключевых кадров", shown["Ключевых кадров этих треков"], setup.usage.video_keys);

// Дубли: окно обязано назвать их до операции, а не после.
await page.getByRole("radio").nth(1).check();
await page.waitForSelector(".mag-warn", { timeout: 15000 });
const warn = (await page.locator(".mag-warn").textContent()).replace(/\s+/g, " ");
check(
  "окно: предупредило о дублях числом сервера",
  warn.includes(String(setup.usage.overlap_images)),
  true
);
await page.screenshot({ path: "/tmp/fate-dialog.png" });

// Стили здесь дважды «не срабатывали» именно так: правило применялось, но
// проигрывало более специфичному соседу. Поэтому спрашиваем движок.
const opt = await page.$eval(".mag-fate-opt", (el) => {
  const cs = getComputedStyle(el);
  const radio = el.querySelector("input");
  const r = radio.getBoundingClientRect();
  const span = el.querySelector("span").getBoundingClientRect();
  return {
    display: cs.display,
    ширинаКружка: Math.round(r.width),
    подписьСправа: span.left > r.right,
    вОднуСтроку: Math.abs(span.top - r.top) < 12,
  };
});
check("переключатель: строка, а не блок", opt.display, "flex");
check("переключатель: кружок остался кружком", opt.ширинаКружка, 15);
check("переключатель: подпись справа и в строку",
      [opt.подписьСправа, opt.вОднуСтроку], [true, true]);

// --- переносим и сверяем счётчики ------------------------------------------- #
await page.locator(".mag-modal-foot .mag-btn").click();
await page.waitForSelector(".mag-fate-table", { state: "detached", timeout: 15000 });
await page.waitForTimeout(400);

const after = await page.$$eval(".mag-classes-table tr", (rows) =>
  rows.map((tr) => ({
    name: tr.cells[2].textContent.trim(),
    n: tr.cells[3].textContent.replace(/\s/g, ""),
  }))
);
check("список: «шпалы» больше нет", after.some((r) => r.name === "шпала"), false);
check(
  "список: у «рельса» разметка обоих классов",
  after.find((r) => r.name === "рельс")?.n,
  "3"
);

// И то же самое у сервера: экран мог показать своё представление, а не базу.
const server = await page.evaluate(async (code) => {
  const r = await (await fetch(`/api/projects/${code}/classes`)).json();
  return r.classes.map((c) => [c.name, c.annotations]);
}, setup.code);
check("сервер: после переноса", server, [["рельс", 3]]);

await browser.close();
if (fails.length) {
  console.error("\nНе сошлось:\n" + fails.join("\n"));
  process.exit(1);
}
console.log("\nВсё сошлось.");
