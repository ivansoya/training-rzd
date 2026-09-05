/** Смотрим глазами браузера на новый слой разметки.
 *
 * Проверять стили «на слово» уже дважды оказывалось ошибкой, а тут переехало
 * всё: разметка ушла из масштабируемого слоя в SVG поверх кадра. Здесь берутся
 * вычисленные значения — то, что реально нарисует движок, — и берутся дважды:
 * на вписанном кадре и на приближенном. Толщина линии и размер якоря обязаны
 * совпасть до пикселя. Прежде они делились на масштаб, и на зуме 12 линия была
 * 0.167px — величина, которую браузер округляет каждую грань по-своему.
 *
 * Проба ходит в **собранный** контейнер, а не в vite: правку интерфейса перед
 * ней надо пересобрать (`docker compose build frontend`).
 *
 *   docker exec -w /work/tests/e2e -e BASE=http://frontend \
 *     -e NODE_PATH=/opt/e2e/node_modules yolo-tests node polyprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const LOGIN = "tester";
const PASSWORD = "123456";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("console", (m) => {
  if (m.type() === "error") console.log("  консоль:", m.text());
});

await page.goto(BASE + "/");
const status = await page.evaluate(async ([login, password]) => {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: login, password }),
  });
  return r.status;
}, [LOGIN, PASSWORD]);
console.log("вход:", status);
if (status !== 200) { await browser.close(); process.exit(1); }

// --- сеем то, на что будем смотреть ---------------------------------------
const seeded = await page.evaluate(async () => {
  const j = (r) => r.json();
  const post = (url, body) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(j);

  const tag = "test-poly-" + Math.random().toString(16).slice(2, 8);
  const project = await post("/api/projects", { name: tag, description: "проба слоя" });
  const cls = await post(`/api/projects/${project.code}/classes`, { name: "вагон" });
  const task = await post(`/api/projects/${project.code}/tasks`, { name: tag });
  await post(`/api/tasks/${task.id}/status`, { status: "in_progress" });

  // Кадр рисуем на месте: серый фон с сеткой, чтобы под обводкой было видно,
  // что она не закрывает картинку.
  const cv = document.createElement("canvas");
  cv.width = 800; cv.height = 500;
  const g = cv.getContext("2d");
  g.fillStyle = "#5a6b7a"; g.fillRect(0, 0, 800, 500);
  g.strokeStyle = "#7d8e9c";
  for (let x = 0; x < 800; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 500); g.stroke(); }
  for (let y = 0; y < 500; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(800, y); g.stroke(); }
  const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.9));

  const fd = new FormData();
  fd.append("files", blob, "test-probe.jpg");
  await fetch(`/api/tasks/${task.id}/images`, { method: "POST", body: fd });

  const listing = await fetch(`/api/tasks/${task.id}/images`).then(j);
  const image = listing.images[0];

  // Один бокс, один объект из двух контуров и один мелкий — на нём проверяем,
  // что якорей не показывают.
  await fetch(`/api/images/${image.id}/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      boxes: [
        { class_index: cls.class_index, x: 60, y: 60, w: 220, h: 160 },
        {
          class_index: cls.class_index, kind: "polygon",
          parts: [
            [[380, 80], [560, 100], [600, 240], [500, 300], [370, 220]],
            [[640, 300], [740, 320], [700, 420], [620, 390]],
          ],
          x: 370, y: 80, w: 370, h: 340,
        },
        { class_index: cls.class_index, x: 100, y: 380, w: 24, h: 22 },
      ],
    }),
  });
  return { code: project.code, taskId: task.id, imageId: image.id };
});
console.log("проект:", seeded.code, "| кадр:", seeded.imageId);

// --- открываем редактор ----------------------------------------------------
await page.goto(`${BASE}/projects/${seeded.code}/tasks/${seeded.taskId}`);
await page.waitForTimeout(1200);
// Кадр уже размечен, значит живёт во вкладке «Прогресс разметки».
await page.getByRole("button", { name: /Прогресс разметки/ }).click();
await page.waitForTimeout(600);
await page.locator(".mag-tile").first().click();
await page.waitForSelector(".mag-cv-layer", { timeout: 15000 });
await page.waitForTimeout(600);

/** Снимок выбранного объекта: его экранный размер и что вокруг него нарисовано.
 *
 *  Опознаём объект по замеру, а не по номеру: сервер отдаёт разметку кадра без
 *  ORDER BY, и порядок между загрузками разный. Проба, привязанная к номеру,
 *  проверяла бы каждый раз что-то другое и «падала» бы через раз.
 */
async function snapshot(label) {
  const data = await page.evaluate(() => {
    const num = (el, prop) => parseFloat(getComputedStyle(el).getPropertyValue(prop));
    const layer = document.querySelector(".mag-cv-layer");
    const on = layer.querySelector(".mag-cv-sh.on");
    const line = on?.querySelector(".mag-cv-line");
    const hull = on?.querySelector(".mag-cv-hull");
    const handle = on?.querySelector(".mag-cv-h");
    const vertex = on?.querySelector(".mag-cv-v");
    const hb = handle?.getBoundingClientRect();
    const vb = vertex?.getBoundingClientRect();
    const r = on?.querySelector(".mag-cv-line")?.getBoundingClientRect();
    const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
    return {
      контур: !!on?.classList.contains("poly"),
      пунктирЛинии: line ? getComputedStyle(line).strokeDasharray : null,
      габарит: (() => {
        const cage = on?.querySelector(".mag-cv-cage");
        return cage ? getComputedStyle(cage).strokeDasharray : null;
      })(),
      радиусВершины: vb ? Math.round(vb.width * 100) / 100 : null,
      заливкаТела: on
        ? getComputedStyle(on.querySelector(".mag-cv-hit")).fill
        : null,
      белаяОбводкаЯкоря: handle ? getComputedStyle(handle).stroke : null,
      белаяОбводкаВершины: vertex ? getComputedStyle(vertex).stroke : null,
      переходЯкоря: handle ? getComputedStyle(handle).transitionProperty : null,
      переходВершины: vertex ? getComputedStyle(vertex).transitionProperty : null,
      экранШирина: round(r?.width),
      экранВысота: round(r?.height),
      меньшаяСторона: r ? round(Math.min(r.width, r.height)) : null,
      толщинаЛинии: line ? num(line, "stroke-width") : null,
      толщинаПодложки: hull ? num(hull, "stroke-width") : null,
      якорей: on ? on.querySelectorAll(".mag-cv-h").length : null,
      якорьПоШирине: round(hb?.width),
      вершин: on ? on.querySelectorAll(".mag-cv-v").length : null,
      вершинаПоШирине: round(vb?.width),
      усыВставки: !!on?.querySelector(".mag-cv-new-edge"),
      объектов: layer.querySelectorAll(".mag-cv-sh").length,
      делениеНаМасштаб: getComputedStyle(
        document.querySelector(".mag-cv-canvas")
      ).getPropertyValue("--z").trim() || "нет",
    };
  });
  console.log(`\n[${label}]`);
  for (const [k, v] of Object.entries(data)) console.log(`  ${k}: ${v}`);
  return data;
}

async function select(i) {
  await page.locator(".mag-cv-sh").nth(i).locator(".mag-cv-hit").first()
    .click({ force: true });
  await page.waitForTimeout(350);
}

async function zoomIn(times) {
  const box = await page.locator(".mag-cv").boundingBox();
  for (let i = 0; i < times; i++) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
  }
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const m = /matrix\(([-\d.]+)/.exec(
      getComputedStyle(document.querySelector(".mag-cv-canvas")).transform
    );
    return m ? Number(m[1]) : 1;
  });
}

/** Выбираем на вписанном кадре, меряем, приближаем, меряем снова.
 *  Выбирать после зума нельзя: объект уезжает из окна, а выделение зум
 *  переживает — значит и не надо. */
async function both(i) {
  await page.keyboard.press("0");
  await page.waitForTimeout(300);
  await select(i);
  const fit = await snapshot(`объект ${i}, вписанный кадр`);
  const z = await zoomIn(14);
  const near = await snapshot(`объект ${i}, приближенный ×${z.toFixed(2)}`);
  return { fit, near, z };
}

const seen = [];
for (let i = 0; i < 3; i++) seen.push(await both(i));

await page.keyboard.press("0");
await page.waitForTimeout(300);

/** Заливка невыбранного объекта: у выбранного её нет по замыслу, значит
 *  мерить надо соседа. */
const rest = await page.evaluate(() => {
  const shapes = [...document.querySelectorAll(".mag-cv-sh")];
  const off = shapes.find((g) => !g.classList.contains("on")) || shapes[0];
  const hit = off.querySelector(".mag-cv-hit");
  return {
    заливкаНевыбранного: getComputedStyle(hit).fill,
    переходЗаливки: getComputedStyle(hit).transitionProperty,
    контур: off.classList.contains("poly"),
  };
});
console.log("\n[невыбранный объект]");
for (const [k, v] of Object.entries(rest)) console.log(`  ${k}: ${v}`);

/** Кинолента: обводка текущего кадра не должна быть ни белой, ни обрезанной. */
const strip = await page.evaluate(() => {
  const cur = document.querySelector(".mag-fs-cell.cur");
  if (!cur) return null;
  const st = getComputedStyle(cur);
  // Кайму ищем на слое поверх превью: тень на самой ячейке рисуется под
  // картинкой, и вычисленный стиль показал бы её там, где её не видно.
  const ring = getComputedStyle(cur, "::before");
  const rail = document.querySelector(".mag-fs-rail");
  const c = cur.getBoundingClientRect();
  const r = rail.getBoundingClientRect();
  return {
    контур: st.outlineStyle,
    внутренняяКайма: ring.boxShadow,
    каймаПоверхПревью: Number(ring.zIndex) >= 2,
    // Обводка рисуется внутрь — значит целиком внутри ленты по всем граням.
    внутриЛентыСлева: c.left >= r.left - 0.5,
    внутриЛентыСверху: c.top >= r.top - 0.5,
  };
});
console.log("\n[кинолента, текущий кадр]");
for (const [k, v] of Object.entries(strip || {})) console.log(`  ${k}: ${v}`);

await page.keyboard.press("0");
await page.waitForTimeout(300);
await select(seen.findIndex((s) => s.fit.контур));
await page.screenshot({ path: `${OUT}/poly-fit.png` });
await zoomIn(10);
await page.screenshot({ path: `${OUT}/poly-zoom.png` });

// --- черновик и память полуавтомата ----------------------------------------
// Вписываем кадр: после замеров он приближен, и клики ушли бы мимо окна.
await page.keyboard.press("0");
await page.waitForTimeout(400);
await page.keyboard.press("KeyP");
await page.waitForTimeout(250);
const fr = await page.locator(".mag-cv-frame").boundingBox();
await page.mouse.click(fr.x + fr.width * 0.2, fr.y + fr.height * 0.75);
await page.mouse.click(fr.x + fr.width * 0.35, fr.y + fr.height * 0.75);
await page.mouse.move(fr.x + fr.width * 0.3, fr.y + fr.height * 0.9);
await page.waitForTimeout(300);
const draft = await page.evaluate(() => {
  const g = document.querySelector(".mag-cv-draft");
  if (!g) return null;
  const line = g.querySelector(".mag-cv-line");
  return {
    подложек: g.querySelectorAll(".mag-cv-hull").length,
    пунктир: getComputedStyle(line).strokeDasharray,
    цвет: getComputedStyle(line).stroke,
  };
});
console.log("\n[черновик контура]");
for (const [k, v] of Object.entries(draft || {})) console.log(`  ${k}: ${v}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// Полуавтомат запоминается: включили при рамке — он же при контуре.
const memory = await page.evaluate(() => {
  const btns = [...document.querySelectorAll(".mag-ed-rail .mag-tool")];
  const auto = btns.find((b) => (b.getAttribute("data-ht") || "").startsWith("Полуавтомат"));
  return { доступен: !!auto && !auto.hasAttribute("disabled") };
});
if (memory.доступен) {
  await page.keyboard.press("KeyB");
  await page.waitForTimeout(200);
  await page.keyboard.press("KeyA");
  await page.waitForTimeout(250);
  const on = () => page.evaluate(() =>
    [...document.querySelectorAll(".mag-ed-rail .mag-tool")]
      .some((b) => (b.getAttribute("data-ht") || "").startsWith("Полуавтомат") &&
                   b.classList.contains("on")));
  memory.включился = await on();
  await page.keyboard.press("KeyP");
  await page.waitForTimeout(250);
  memory.переживаетКонтур = await on();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  memory.переживаетEscape = await on();
  await page.keyboard.press("KeyA");
  await page.waitForTimeout(200);
}
console.log("\n[память полуавтомата]");
for (const [k, v] of Object.entries(memory)) console.log(`  ${k}: ${v}`);

// --- справка и превью ------------------------------------------------------
const chrome = await page.evaluate(() => {
  const ed = document.querySelector(".mag-ed");
  return {
    вечныхПодсказок:
      ed.querySelectorAll(".mag-ed-hint, .mag-ed-keys, .mag-ed-hint-rail").length,
    // У включённых органов всплывашек быть не должно вовсе. У выключенных
    // остаётся диагноз («модель недоступна») — это не подсказка, а причина,
    // по которой на кнопку нельзя нажать, и справка её сказать не может.
    // Всплывашек-инструкций быть не должно. Не в счёт: выключенная кнопка
    // (там всплывашка объясняет, почему на неё нельзя нажать) и плитка
    // киноленты (там это имя файла — содержимое, а не инструкция).
    всплывашекTitle: [...ed.querySelectorAll("[title]")]
      .filter((n) => !n.hasAttribute("disabled") && !n.closest(".mag-fs-cell"))
      .length,
    меченыхДляСправки: ed.querySelectorAll("[data-help]").length,
    кнопкаСправки: !!ed.querySelector(".mag-ed-head button"),
  };
});

// Включаем справку кнопкой и смотрим, что она делает.
await page.getByRole("button", { name: "справка" }).click();
await page.waitForTimeout(300);
const helpOn = await page.evaluate(() => {
  const ed = document.querySelector(".mag-ed");
  const list = ed.querySelectorAll(".mag-ed-help-list div");
  const marked = ed.querySelector("[data-help]");
  return {
    строкСправки: list.length,
    экранПогашен: !!ed.querySelector(".mag-ed-dim"),
    органыПодсвечены: marked ? getComputedStyle(marked).outlineStyle : null,
  };
});
await page.screenshot({ path: `${OUT}/help.png` });
await page.getByRole("button", { name: "справка" }).click();
await page.waitForTimeout(200);

console.log("\n[справка]");
for (const [k, v] of Object.entries({ ...chrome, ...helpOn }))
  console.log(`  ${k}: ${v}`);

// Превью: контур и рамка обязаны различаться.
const mini = await page.evaluate(() => {
  const cell = document.querySelector(".mag-fs-cell");
  const svg = cell?.querySelector(".mag-shp");
  if (!svg) return null;
  const box = svg.querySelector(".mag-shp-box");
  const poly = svg.querySelector(".mag-shp-poly");
  return {
    слойЕсть: true,
    рамок: svg.querySelectorAll(".mag-shp-box").length,
    контуров: svg.querySelectorAll(".mag-shp-poly").length,
    заливкаРамки: box ? getComputedStyle(box).fill : null,
    заливкаКонтура: poly ? getComputedStyle(poly).fill : null,
    // Слой поверх картинки обязан быть прозрачным: имя `.mag-mini` уже было
    // занято полоской с непрозрачным фоном, и превью заливало серым.
    фонСлоя: getComputedStyle(svg).backgroundColor,
    картинкаВидна: (() => {
      const img = cell.querySelector("img");
      return !!img && img.naturalWidth > 0;
    })(),
  };
});
console.log("\n[превью в ленте]");
for (const [k, v] of Object.entries(mini || {})) console.log(`  ${k}: ${v}`);

// --- жесты: то, чего снимок не покажет -------------------------------------
const N = (sel) => page.evaluate((q) => document.querySelectorAll(q).length, sel);

/** Кликаем в точку кадра по её координатам в исходнике. */
async function clickImage(ix, iy, opts = {}) {
  const box = await page.locator(".mag-cv-frame").boundingBox();
  await page.mouse.click(box.x + (ix / 800) * box.width,
                         box.y + (iy / 500) * box.height, opts);
  await page.waitForTimeout(300);
}

await page.keyboard.press("0");
await page.waitForTimeout(300);

// Выбираем контур: он единственный с классом poly.
const polyIdx = await page.evaluate(() =>
  [...document.querySelectorAll(".mag-cv-sh")].findIndex((g) =>
    g.classList.contains("poly"))
);
await select(polyIdx);

const gestures = {};
gestures.вершинДо = await N(".mag-cv-v");

// Alt наводит подсказку на ближайшую грань. Целимся в середину грани
// пятиугольника (380,80)-(560,100): около (470, 90), но чуть в стороне —
// точка обязана лечь на грань, а не под курсор.
await page.keyboard.down("Alt");
const frame = await page.locator(".mag-cv-frame").boundingBox();
await page.mouse.move(frame.x + (470 / 800) * frame.width,
                      frame.y + (78 / 500) * frame.height);
await page.waitForTimeout(300);
gestures.подсказкаПоказана = (await N(".mag-cv-new")) === 1;
gestures.усыКГраниПоказаны = (await N(".mag-cv-new-edge")) === 1;
// Подсказка обязана стоять под курсором, а не на грани: грань идёт по y=80..100
// около x=470, курсор мы держим на y=78 — то есть заметно выше неё.
gestures.подсказкаПодКурсором = await page.evaluate(() => {
  const d = document.querySelector(".mag-cv-new")?.getAttribute("d") || "";
  const m = /^M([-\d.]+) ([-\d.]+)/.exec(d);
  const frame = document.querySelector(".mag-cv-frame").getBoundingClientRect();
  const stage = document.querySelector(".mag-cv").getBoundingClientRect();
  if (!m) return null;
  // Ромб рисуется от верхней точки: центр ниже неё на радиус.
  const cy = Number(m[2]) + 8;
  return ((cy - (frame.top - stage.top)) / frame.height) * 500;
});
gestures.вершиныНеЛовятСобытий = await page.evaluate(() => {
  const v = document.querySelector(".mag-cv-layer.alt .mag-cv-v");
  return !!v && getComputedStyle(v).pointerEvents === "none";
});
await clickImage(470, 78);
await page.keyboard.up("Alt");
await page.waitForTimeout(300);
gestures.вершинПослеAlt = await N(".mag-cv-v");

// По умолчанию контур двигать нельзя: тянем и убеждаемся, что он не уехал.
await clickImage(680, 355);
const lockedBefore = await page.evaluate(() =>
  [...document.querySelectorAll(".mag-cv-sh.poly .mag-cv-hit")]
    .map((n) => n.getAttribute("d")).join("|"));
await page.mouse.move(frame.x + (680 / 800) * frame.width,
                      frame.y + (355 / 500) * frame.height);
await page.mouse.down();
await page.mouse.move(frame.x + (740 / 800) * frame.width,
                      frame.y + (415 / 500) * frame.height, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
const lockedAfter = await page.evaluate(() =>
  [...document.querySelectorAll(".mag-cv-sh.poly .mag-cv-hit")]
    .map((n) => n.getAttribute("d")).join("|"));
gestures.безРазрешенияНеДвигается = lockedBefore === lockedAfter;

// Тумблеры — в настройках контура.
await page.keyboard.press("KeyP");
await page.waitForTimeout(250);
await page.locator('.mag-tool[data-ht^="Настройки контура"]').click();
await page.waitForTimeout(250);
await page.getByText("Двигать контуры").click();
await page.waitForTimeout(200);
await page.getByText("Части по отдельности").click();
await page.waitForTimeout(250);
// Возвращаемся в выбор кнопкой, а не клавишей: проба не должна зависеть от
// того, где сейчас фокус, — это про неё, а не про редактор.
await page.locator('.mag-tool[data-ht^="Выбор и правка"]').click();
await page.waitForTimeout(250);

// Берём вторую часть — четырёхугольник около (680, 355).
await clickImage(680, 355);
gestures.частьВыделена = (await N(".mag-cv-part")) === 1;

const partBefore = await page.evaluate(() => {
  const d = document.querySelector(".mag-cv-part")?.getAttribute("d") || "";
  const other = [...document.querySelectorAll(".mag-cv-sh.poly .mag-cv-hit")]
    .map((n) => n.getAttribute("d"));
  return { part: d, all: other };
});
// Тянем выделенную часть вправо-вниз.
await page.mouse.move(frame.x + (680 / 800) * frame.width,
                      frame.y + (355 / 500) * frame.height);
await page.mouse.down();
await page.mouse.move(frame.x + (720 / 800) * frame.width,
                      frame.y + (395 / 500) * frame.height, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
const partAfter = await page.evaluate(() => {
  const other = [...document.querySelectorAll(".mag-cv-sh.poly .mag-cv-hit")]
    .map((n) => n.getAttribute("d"));
  return { all: other };
});
const moved = partBefore.all.filter((d, k) => d !== partAfter.all[k]).length;
gestures.двинуласьТолькоОдначасть = moved === 1;

// Del убирает выделенное. Часть при включённом тумблере — значит объект
// останется, но контуров в нём станет меньше.
const shapesBefore = await N(".mag-cv-sh");
const partsBefore = await N(".mag-cv-sh.poly .mag-cv-hit");
await page.keyboard.press("Delete");
await page.waitForTimeout(400);
gestures.DelУбралЧасть =
  (await N(".mag-cv-sh")) === shapesBefore &&
  (await N(".mag-cv-sh.poly .mag-cv-hit")) === partsBefore - 1;

// Теперь объект целиком: часть осталась одна, Del уносит объект.
await clickImage(470, 200);
await page.keyboard.press("Delete");
await page.waitForTimeout(400);
gestures.DelУбралОбъект = (await N(".mag-cv-sh")) === shapesBefore - 1;

console.log("\n[жесты]");
for (const [k, v] of Object.entries(gestures)) console.log(`  ${k}: ${v}`);

// --- вердикт: проверяем правило, а не фикстуру -----------------------------
const near = (a, b, eps = 0.51) => a !== null && b !== null && Math.abs(a - b) < eps;
const ANCHORS_AT = 44;          // те же числа, что в overlay.ts
const all = seen.flatMap((s) => [s.fit, s.near]);
const contours = all.filter((s) => s.контур);
const rects = all.filter((s) => !s.контур);

const checks = [
  ["толщина линии одна на любом масштабе",
    all.every((s) => near(s.толщинаЛинии, all[0].толщинаЛинии))],
  ["толщина подложки одна на любом масштабе",
    all.every((s) => near(s.толщинаПодложки, all[0].толщинаПодложки))],
  ["якорь всегда 10 экранных пикселей",
    rects.filter((s) => s.якорей > 0).every((s) => near(s.якорьПоШирине, 10))],
  [`бокс крупнее ${ANCHORS_AT}px показывает якоря`,
    rects.filter((s) => s.меньшаяСторона >= ANCHORS_AT).every((s) => s.якорей > 0)],
  [`бокс мельче ${ANCHORS_AT}px якорей не показывает: в них не попасть`,
    rects.filter((s) => s.меньшаяСторона < ANCHORS_AT).every((s) => s.якорей === 0)],
  ["правило сработало в обе стороны на одном и том же объекте",
    seen.some((s) => !s.fit.контур && s.fit.якорей === 0 && s.near.якорей > 0)],
  ["у контура якорей нет — рамка это показание, а не орган управления",
    contours.length > 0 && contours.every((s) => s.якорей === 0)],
  ["вершины контура нарисованы и не толстеют",
    contours.length > 1 && contours.every((s) => s.вершин === 9) &&
    // Сравниваем масштабы между собой, а не с числом: размер знака — вопрос
    // вкуса и меняется, а вот «не зависит от зума» — свойство, ради которого
    // всё и переписывалось.
    near(contours[0].вершинаПоШирине, contours[1].вершинаПоШирине)],
  ["объектов на слое три", all.every((s) => s.объектов === 3)],
  ["деления на масштаб в вёрстке не осталось",
    all.every((s) => s.делениеНаМасштаб === "нет")],

  // --- то, что просили переделать ---
  ["у якоря нет белой обводки",
    rects.filter((s) => s.якорей > 0)
      .every((s) => !/255,\s*255,\s*255/.test(s.белаяОбводкаЯкоря || ""))],
  ["у вершины нет белой обводки",
    contours.every((s) => !/255,\s*255,\s*255/.test(s.белаяОбводкаВершины || ""))],
  ["якорь и вершина анимируют переход",
    rects.filter((s) => s.якорей > 0).every((s) => /transform/.test(s.переходЯкоря || "")) &&
    contours.every((s) => /transform/.test(s.переходВершины || ""))],
  ["сам контур сплошной",
    contours.every((s) => !s.пунктирЛинии || s.пунктирЛинии === "none")],
  ["вокруг контура пунктирный габарит",
    contours.every((s) => /\d/.test(s.габарит || ""))],
  ["у бокса рамка сплошная и габарита нет",
    rects.every((s) => (!s.пунктирЛинии || s.пунктирЛинии === "none") && !s.габарит)],
  ["вершина крупная — от 12 экранных пикселей",
    contours.every((s) => (s.вершинаПоШирине || 0) >= 12)],
  ["у выбранного объекта фона нет",
    all.every((s) => /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(s.заливкаТела || ""))],
  ["у невыбранного фон цвета класса есть",
    !!rest.заливкаНевыбранного &&
    !/rgba\(0,\s*0,\s*0,\s*0\)/.test(rest.заливкаНевыбранного)],
  ["заливка анимирует переход", /fill/.test(rest.переходЗаливки || "")],
  ["в ленте нет обводки наружу", strip?.контур === "none"],
  ["кайма ленты нарисована внутрь и не белая",
    !!strip?.внутренняяКайма && /inset/.test(strip.внутренняяКайма) &&
    !/255,\s*255,\s*255/.test(strip.внутренняяКайма)],
  ["кайма лежит поверх превью, а не под ним", !!strip?.каймаПоверхПревью],
  ["текущий кадр не обрезан лентой",
    !!strip?.внутриЛентыСлева && !!strip?.внутриЛентыСверху],

  // --- жесты ---
  ["Alt показывает, куда встанет вершина", gestures.подсказкаПоказана],
  ["и какую грань она разделит", gestures.усыКГраниПоказаны],
  ["подсказка стоит под курсором, а не на грани",
    Math.abs((gestures.подсказкаПодКурсором ?? 0) - 78) < 6],
  ["без разрешения контур не двигается", gestures.безРазрешенияНеДвигается],
  ["под Alt вершины не перехватывают нажатие", gestures.вершиныНеЛовятСобытий],
  ["Alt добавляет ровно одну вершину",
    gestures.вершинПослеAlt === gestures.вершинДо + 1],
  ["часть объекта выделяется отдельно", gestures.частьВыделена],
  ["двигается только выделенная часть", gestures.двинуласьТолькоОдначасть],
  ["Del убирает выделенную часть", gestures.DelУбралЧасть],
  ["Del убирает объект, когда часть в нём одна", gestures.DelУбралОбъект],

  // --- справка вместо вечных подсказок ---
  ["вечных подсказок в интерфейсе нет", chrome.вечныхПодсказок === 0],
  ["у включённых органов нет всплывашек", chrome.всплывашекTitle === 0],
  ["органы управления помечены для справки", chrome.меченыхДляСправки > 8],
  ["справка перечисляет сочетания", helpOn.строкСправки > 8],
  ["справка гасит экран", helpOn.экранПогашен],
  ["и подсвечивает органы управления", helpOn.органыПодсвечены === "solid"],

  // --- превью ---
  ["у черновика нет тёмной подложки", draft?.подложек === 0],
  ["черновик — пунктир цвета класса",
    /\d/.test(draft?.пунктир || "") &&
    !/rgb\(0,\s*0,\s*0\)/.test(draft?.цвет || "")],
  ["полуавтомат переживает смену инструмента",
    !memory.доступен || (memory.включился && memory.переживаетКонтур)],
  ["и не забывается по Escape",
    !memory.доступен || memory.переживаетEscape],

  ["в ленте есть слой разметки", !!mini?.слойЕсть],
  ["на превью рамка и контур нарисованы разными фигурами",
    (mini?.рамок || 0) > 0 && (mini?.контуров || 0) > 0],
  ["и различаются весом заливки",
    !!mini?.заливкаРамки && mini.заливкаРамки !== mini.заливкаКонтура],
  ["слой превью прозрачен — картинку он не закрывает",
    /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(mini?.фонСлоя || "")],
  ["превью кадра при этом на месте", !!mini?.картинкаВидна],
];
console.log("");
let bad = 0;
for (const [what, ok] of checks) {
  console.log(`${ok ? "  ок  " : "ПЛОХО "} ${what}`);
  if (!ok) bad++;
}
console.log(`\nснимки: ${OUT}/poly-fit.png, ${OUT}/poly-zoom.png`);

await browser.close();
process.exit(bad ? 1 : 0);
