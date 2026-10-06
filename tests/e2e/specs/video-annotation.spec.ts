import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * Сквозной путь размечаемого видео: человек регистрируется, подтверждает
 * почту по настоящей ссылке из письма, заводит проект и таску, загружает
 * ролик и размечает его трек-боксом.
 *
 * Подготовка (проект, класс, таска, загрузка файла) идёт через API той же
 * вкладки — сессия у них общая. Кликами проверяется то, ради чего сквозной
 * тест и нужен: что редактор открывается, показывает кадр и что нарисованный
 * объект действительно доезжает до сервера.
 */

const SAMPLE = process.env.TEST_SAMPLE_VIDEO || "/tmp/magistral-sample-30f.mp4";

const LONG_SAMPLE = process.env.TEST_SAMPLE_LONG || "/tmp/magistral-sample-300f.mp4";
// 1024×768: у ролика 240p ступеней качества нет вовсе — переключать нечего.
const TALL_SAMPLE = process.env.TEST_SAMPLE_TALL || "/tmp/magistral-sample-tall.mp4";

/**
 * Умеет ли браузер стенда разжимать H.264.
 *
 * Перегоны отдаются в H.264 — он есть во всех браузерах, которыми размечают.
 * Но в Chromium, который приносит с собой Playwright, проприетарных кодеков
 * нет, а настоящий Chrome под Linux ARM64 не собирают. На такой машине проверки
 * покадровой точности пропускаются, и единственным их подтверждением остаётся
 * API-тест: он разжимает перегон на сервере и читает номер с картинки.
 */
async function decodesH264(page: Page): Promise<boolean> {
  // Спрашивать надо со страницы стенда: WebCodecs есть только в защищённом
  // контексте. Но если мы уже где-то внутри приложения — оставаться там:
  // переход снёс бы открытый редактор вместе с проверяемым.
  if (!page.url().startsWith("http")) await page.goto("/");
  return page.evaluate(async () => {
    const VD = (window as unknown as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
    if (!VD) return false;
    try {
      const res = await VD.isConfigSupported({
        codec: "avc1.640028", codedWidth: 320, codedHeight: 240,
      });
      return Boolean(res.supported);
    } catch {
      return false;
    }
  });
}

/** Нарисовалось ли на холсте хоть что-то, кроме пустоты. */
function drawn(canvas: Locator): Promise<boolean> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx || !el.width) return false;
    const data = ctx.getImageData(0, 0, Math.min(el.width, 40), Math.min(el.height, 40)).data;
    return data.some((v, i) => i % 4 !== 3 && v > 0);
  });
}

/**
 * Номер кадра, прочитанный с самой картинки.
 *
 * На каждом кадре тестового ролика он нарисован девятью клетками: светлая —
 * единица. Это и есть главная проверка всей затеи: заголовкам перегона и
 * подписи в интерфейсе тест не верит, он смотрит на пиксели. Если нумерация
 * съедет — при нарезке, при перекодировании, на границе перегона или из-за
 * переставленных декодером кадров, — бокс уедет на чужой кадр и молча попадёт
 * в датасет. Разметка в координатах исходника, поэтому и клетки ищутся в них.
 */
function frameMark(editor: Locator): Promise<number> {
  return editor.locator(".mag-cv-frame canvas").first().evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx || !el.width) return -1;
    const kx = el.width / 320;
    const ky = el.height / 240;
    let value = 0;
    for (let bit = 0; bit < 9; bit += 1) {
      const x = Math.round((10 + bit * 33 + 15) * kx);
      const y = Math.round((12 + 15) * ky);
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      value = (value << 1) | ((r + g + b) / 3 > 128 ? 1 : 0);
    }
    return value;
  });
}

/** Проект, класс, таска и загруженный длинный ролик — всё через API. */
async function longClip(page: Page, sample = LONG_SAMPLE) {
  await signIn(page);
  const project = await (
    await page.request.post("/api/projects", { data: { name: tag() } })
  ).json();
  await page.request.post(`/api/projects/${project.code}/classes`, { data: { name: "вагон" } });
  const task = await (
    await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })
  ).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });

  const upload = await page.request.post(`/api/tasks/${task.id}/videos`, {
    multipart: {
      file: { name: "sample-300f.mp4", mimeType: "video/mp4", buffer: readFileSync(sample) },
      mode: "annotate",
    },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  return { project, task, video: await upload.json() };
}

/** Выбрать ступень качества в выпадашке транспорта. */
async function pickQuality(editor: Locator, label: string) {
  await editor.getByRole("combobox", { name: "Качество" }).click();
  await editor.page().getByRole("option", { name: new RegExp(`^${label}`) }).click();
}

/** Карточка источника на странице таски по заголовку. */
function source(page: Page, title: string): Locator {
  return page.locator(".tp-src", { hasText: title });
}

/** Строка ролика на разметку. */
function reel(page: Page): Locator {
  return page.locator(".tp-vid").first();
}

/** Кнопка редактора по началу подписи. */
function control(editor: Locator, text: string): Locator {
  return editor.getByRole("button", { name: new RegExp(`^${text}`) });
}

/** Ошибка редактора — плашка под шапкой. */
function failure(editor: Locator): Locator {
  return editor.locator(".ed-notes .ui-notice.error");
}

/** Шкала кадров над дорожками — она же ползунок перемотки. */
function slider(editor: Locator): Locator {
  return editor.getByRole("slider", { name: "Кадр" });
}

/** Номер кадра, который показывает интерфейс. */
async function uiFrame(editor: Locator): Promise<number> {
  return Number(await slider(editor).getAttribute("aria-valuenow"));
}

/** Перейти на кадр клавишами шкалы: Home, затем десятками и единицами. */
async function seek(editor: Locator, frame: number) {
  const ruler = slider(editor);
  await ruler.focus();
  await ruler.press("Home");
  for (let i = 0; i < Math.floor(frame / 10); i += 1) await ruler.press("Shift+ArrowRight");
  for (let i = 0; i < frame % 10; i += 1) await ruler.press("ArrowRight");
  await expect.poll(() => uiFrame(editor)).toBe(frame);
}

async function openEditor(page: Page, project: { code: string }, task: { id: string }) {
  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  await reel(page).getByRole("button", { name: "Размечать ролик" }).click();
  const editor = page.getByRole("dialog", { name: "Разметка видео" });
  await expect(editor).toBeVisible();
  return editor;
}

/** Короткий ролик в разметке: проект, класс, таска и загрузка — всё через API. */
async function shortClip(page: Page) {
  await signIn(page);
  const project = await (
    await page.request.post("/api/projects", { data: { name: tag() } })
  ).json();
  await page.request.post(`/api/projects/${project.code}/classes`, {
    data: { name: "вагон" },
  });
  const task = await (
    await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })
  ).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });

  const upload = await page.request.post(`/api/tasks/${task.id}/videos`, {
    multipart: {
      file: { name: "sample.mp4", mimeType: "video/mp4", buffer: readSample() },
      mode: "annotate",
    },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  return { project, task, video: await upload.json() };
}

test("ролик виден в таске как размечаемый и открывает редактор", async ({ page }) => {
  const { project, task } = await shortClip(page);

  // --- дальше только интерфейс ---
  await page.goto(`/projects/${project.code}/tasks/${task.id}`);

  const card = reel(page);
  await expect(card).toBeVisible();
  await expect(card.getByText("размечается")).toBeVisible();
  // Ролик ещё не закрыт, поэтому кадров в таске нет, а работа уже видна.
  await expect(card.getByText(/объектов ведётся/)).toBeVisible();

  await card.getByRole("button", { name: "Размечать ролик" }).click();

  const editor = page.getByRole("dialog", { name: "Разметка видео" });
  await expect(editor).toBeVisible();
  await expect(editor.locator(".ve-pos")).toContainText(/кадр\s+0\s+из\s+30/);

  // Кадр разжимается в браузере из перегона и рисуется на холсте — без него
  // рисовать не по чему.
  const frame = editor.locator(".mag-cv-frame canvas").first();
  await expect(frame).toBeVisible();
  if (await decodesH264(page)) {
    await expect(async () => {
      expect(await drawn(frame)).toBeTruthy();
    }).toPass();
  }

});

test("видео размечается треком и объект остаётся на сервере", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Обвести объект не по чему: браузер стенда не разжимает H.264"
  );
  const { project, task, video } = await shortClip(page);
  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  await reel(page).getByRole("button", { name: "Размечать ролик" }).click();
  const editor = page.getByRole("dialog", { name: "Разметка видео" });
  await expect(editor).toBeVisible();
  const frame = editor.locator(".mag-cv-frame canvas").first();
  await expect(async () => {
    expect(await drawn(frame)).toBeTruthy();
  }).toPass();

  await editor.getByRole("button", { name: "Трек", exact: true }).click();

  const box = await frame.boundingBox();
  if (!box) throw new Error("Кадр не отрисовался");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.75, { steps: 12 });
  await page.mouse.up();

  // Объект появился дорожкой внизу и строкой справа — сервер его принял и отдал обратно.
  await expect(editor.locator(".ve-r[data-track-id]")).toHaveCount(1);
  await expect(editor.locator(".ve-side .fe-obj")).toHaveCount(1);

  const saved = await (
    await page.request.get(`/api/tasks/${task.id}/videos/${video.id}/annotations`)
  ).json();
  expect(saved.tracks).toHaveLength(1);
  expect(saved.tracks[0].keys).toHaveLength(1);
  expect(saved.tracks[0].keys[0].frame_no).toBe(0);

  const detail = await (await page.request.get(`/api/tasks/${task.id}`)).json();
  expect(detail.videos[0].tracks).toBe(1);
});

test("нарезаемое видео живёт в «Роликах на нарезку» и открывает нарезку", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/projects", { data: { name: tag() } })
  ).json();
  const task = await (
    await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })
  ).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });
  await page.request.post(`/api/tasks/${task.id}/videos`, {
    multipart: {
      file: { name: "sample.mp4", mimeType: "video/mp4", buffer: readSample() },
      mode: "cut",
    },
  });

  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  const block = source(page, "Ролики на нарезку");
  await expect(block.getByText("не нарезан", { exact: true })).toBeVisible();
  await block.getByRole("button", { name: "Нарезать", exact: true }).click();
  const cut = page.getByRole("dialog", { name: "sample.mp4" });
  await expect(cut).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Разметка видео" })).toHaveCount(0);

  // Протяжка по ленте ножницами — новый участок, «Применить» обещает кадры
  await expect(cut.getByRole("button", { name: /Ножницы/ })).toHaveAttribute("aria-pressed", "true");
  const track = cut.locator(".vc-track");
  const box = (await track.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(cut.locator(".vc-seg")).toHaveCount(1);
  await expect(cut.locator(".vc-card")).toHaveCount(1);
  const apply = cut.getByRole("button", { name: /^Применить \+\d+/ });
  await expect(apply).toBeEnabled();

  // Щелчок без протяжки участка не рисует
  await page.mouse.click(box.x + box.width * 0.95, box.y + box.height / 2);
  await expect(cut.locator(".vc-seg")).toHaveCount(1);

  await apply.click();
  await expect(cut.getByText("Нарезано")).toBeVisible({ timeout: 60_000 });
  await cut.getByRole("button", { name: "Вернуться к таске" }).click();
  await expect(cut).toBeHidden();
  await expect(block.getByRole("button", { name: "Нарезать ещё" })).toBeVisible();
});

test("режим ролика задаёт пункт, которым его добавили", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/projects", { data: { name: tag() } })
  ).json();
  const task = await (
    await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })
  ).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });

  const modes = async () =>
    ((await (await page.request.get(`/api/tasks/${task.id}`)).json()).videos as { mode: string }[])
      .map((v) => v.mode)
      .sort();

  // Режим не спрашивают: пустая таска предлагает три способа, дальше — меню «Добавить»
  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  const first = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /^Видео на разметку/ }).click();
  await (await first).setFiles(SAMPLE);
  await expect(reel(page).getByText("размечается")).toBeVisible();

  const second = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Добавить" }).click();
  await page.getByRole("button", { name: /^Видео на нарезку/ }).click();
  await (await second).setFiles(SAMPLE);
  await expect(source(page, "Ролики на нарезку")).toBeVisible();
  await expect.poll(modes).toEqual(["annotate", "cut"]);
});

function readSample(): Buffer {
  return readFileSync(SAMPLE);
}

test("разметка закрывается и становится кадрами таски", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/projects", { data: { name: tag() } })
  ).json();
  await page.request.post(`/api/projects/${project.code}/classes`, { data: { name: "вагон" } });
  const task = await (
    await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })
  ).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });
  const video = await (
    await page.request.post(`/api/tasks/${task.id}/videos`, {
      multipart: {
        file: { name: "sample.mp4", mimeType: "video/mp4", buffer: readSample() },
        mode: "annotate",
      },
    })
  ).json();

  // Трек заводим через API: рисование мышью проверяется отдельным тестом.
  const track = await (
    await page.request.post(`/api/tasks/${task.id}/videos/${video.id}/tracks`, {
      data: { class_index: 0, frame_no: 0, geometry: { x: 10, y: 90, w: 60, h: 60 } },
    })
  ).json();
  await page.request.patch(`/api/video-tracks/${track.id}`, { data: { export_step: 30 } });

  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  await reel(page).getByRole("button", { name: "Закрыть разметку" }).click();

  // Кадры появляются в таске до всякой сдачи — это обычные кадры.
  await expect(page.locator(".ui-notice").getByText(/Разметка .* закрыта/)).toBeVisible({ timeout: 30_000 });
  await expect(reel(page).getByText("разметка закрыта")).toBeVisible();

  const block = source(page, "Из разметки «sample.mp4»");
  await expect(block).toBeVisible();
  await expect(block.getByRole("button", { name: "Проверить" })).toBeVisible();
});

test("шаг стрелкой показывает соседний кадр, а не соседний примерно", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page);
  const editor = await openEditor(page, project, task);

  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(0);

  const forward = control(editor, "Кадр вперёд");
  for (const expected of [1, 2, 3]) {
    await forward.click();
    await expect.poll(() => frameMark(editor), { timeout: 15_000 }).toBe(expected);
  }

  const back = control(editor, "Кадр назад");
  await back.click();
  await expect.poll(() => frameMark(editor), { timeout: 15_000 }).toBe(2);
});

test("прыжок по шкале грузит нужный перегон", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page);
  const editor = await openEditor(page, project, task);
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(0);

  // 200 лежит во втором перегоне: проверяется и прыжок, и подгрузка.
  await seek(editor, 200);
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(200);

  // Назад через две границы перегонов — туда, где уже были.
  await seek(editor, 5);
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(5);
});

test("граница перегона не теряет и не задваивает кадр", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page);
  const editor = await openEditor(page, project, task);

  // Встаём перед стыком и переходим его шагами: 119 — последний кадр первого
  // перегона, 120 — первый кадр второго.
  await seek(editor, 118);
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(118);

  const forward = control(editor, "Кадр вперёд");
  for (const expected of [119, 120, 121]) {
    await forward.click();
    await expect.poll(() => frameMark(editor), { timeout: 20_000 }).toBe(expected);
  }

  await control(editor, "Кадр назад").click();
  await expect.poll(() => frameMark(editor), { timeout: 20_000 }).toBe(120);
});

test("ступень качества меняет картинку, но не кадр", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page, TALL_SAMPLE);
  const editor = await openEditor(page, project, task);
  await seek(editor, 77);
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(77);

  // Холст всегда в координатах исходника — о ступени говорит запрошенный перегон.
  for (const [label, q] of [["480p", "480"], ["Исходное", "src"]]) {
    const asked = page.waitForRequest((r) => /\/chunks\/\d+\?q=/.test(r.url()) && r.url().endsWith(`q=${q}`));
    await pickQuality(editor, label);
    await asked;
    // Кадр обязан остаться тем же: иначе «резкость» уводила бы разметчика.
    await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(77);
  }
});

test("проигрывание не срывает декодер", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page);
  const editor = await openEditor(page, project, task);
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(0);

  const play = editor.locator(".ve-play");
  await play.click();
  await page.waitForTimeout(3000);
  await play.click();

  // Ролик и правда шёл, а не стоял на месте.
  const at = await uiFrame(editor);
  expect(at).toBeGreaterThan(10);

  // Ни одного срыва разжатия: раньше здесь падало «нужен опорный кадр» —
  // декодер после слива не принимал обычный кадр, картинка застывала, а
  // время продолжало идти.
  await expect(failure(editor)).toHaveCount(0);

  // И картинка догнала остановленное время, а не осталась где-то позади.
  await expect.poll(() => frameMark(editor), { timeout: 20_000 }).toBe(at);
});

test("проигрывание проходит границу перегона без провала", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page);
  const editor = await openEditor(page, project, task);

  // Встаём незадолго до границы: перегон 0 кончается кадром 119.
  await seek(editor, 100);
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(100);

  await editor.locator(".ve-play").click();
  // Пока идёт ролик, время не имеет права убегать от картинки: раньше полоса
  // бежала вперёд, кадр замирал, и кусок ролика проходил незамеченным.
  const behind: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    await page.waitForTimeout(200);
    const ui = await uiFrame(editor);
    behind.push(ui - (await frameMark(editor)));
  }
  await editor.locator(".ve-play").click();
  expect(Math.max(...behind), `отставание картинки по замерам: ${behind}`).toBeLessThanOrEqual(2);

  const at = await uiFrame(editor);
  // Границу прошли — иначе тест ничего не проверил.
  expect(at).toBeGreaterThan(120);
  await expect(failure(editor)).toHaveCount(0);
  // Декодер следующего перегона грелся заранее, поэтому картинка не отстала.
  await expect.poll(() => frameMark(editor), { timeout: 20_000 }).toBe(at);
});

test("на ожидании кадр гаснет, и ничего не дёргается", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page);
  // Придерживаем перегон 2: без этого на маленьком ролике ожидание не успевает
  // возникнуть, и проверять оказывается нечего.
  await page.route("**/chunks/2*", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  const editor = await openEditor(page, project, task);
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(0);

  // Строка времени не имеет права раздвигаться, когда загорается точка.
  const before = await slider(editor).boundingBox();

  await seek(editor, 250);

  const busy = editor.locator(".ve-busy");
  await expect(busy).toBeVisible();

  const during = await slider(editor).boundingBox();
  expect(Math.abs((during?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(1);

  // Дождались — полоса ушла, кадр тот самый.
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(250);
  await expect(busy).toHaveCount(0);
});

test("качество можно переключать подряд, и редактор возвращается в строй", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page, TALL_SAMPLE);
  const editor = await openEditor(page, project, task);
  await seek(editor, 150);
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(150);

  // Две ступени подряд: раньше перегон прежнего качества дописывался в кэш
  // уже после переключения, ожидание застывало и таймлайн переставал двигать
  // кадр — ползунок ездит, картинка стоит.
  await pickQuality(editor, "Исходное");
  await pickQuality(editor, "480p");

  await expect.poll(() => frameMark(editor), { timeout: 60_000 }).toBe(150);
  await expect(failure(editor)).toHaveCount(0);

  // И редактор жив: шаг вперёд показывает следующий кадр.
  await control(editor, "Кадр вперёд").click();
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(151);
});

test("кнопки плеера не меняют размер и не двигают таймлайн", async ({ page }) => {
  const { project, task } = await shortClip(page);
  const editor = await openEditor(page, project, task);

  const scrub = editor.getByRole("slider", { name: "Кадр" });
  const before = await scrub.boundingBox();

  // ▶ превращается в ⏸ — раньше от этого ехал ряд.
  const play = editor.locator(".ve-play");
  await play.click();
  const during = await scrub.boundingBox();
  await play.click();

  expect(Math.abs((during?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(1);
  expect(Math.abs((during?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(1);

  // Скорости тоже одной ширины: ¼ и 2× сами по себе разные.
  const widths = await editor
    .getByRole("group", { name: "Скорость" }).getByRole("button")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  expect(new Set(widths).size, `ширины кнопок скорости: ${widths}`).toBe(1);
});

test("окно «Клавиши» перечисляет управление", async ({ page }) => {
  const { project, task } = await shortClip(page);
  const editor = await openEditor(page, project, task);

  await editor.getByRole("button", { name: /^Клавиши/ }).click();
  const keys = page.getByRole("dialog", { name: "Клавиши" });
  await expect(keys).toBeVisible();
  await expect(keys.getByText(/^Играть или остановить/)).toBeVisible();
  await expect(keys.getByText("Трек: объект, живущий во времени")).toBeVisible();
  await expect(keys.locator("kbd").filter({ hasText: "Пробел" }).first()).toBeVisible();

  // Esc закрывает окно, а не редактор под ним
  await page.keyboard.press("Escape");
  await expect(keys).toHaveCount(0);
  await expect(editor).toBeVisible();

  await page.keyboard.press("?");
  await expect(keys).toBeVisible();
});

test("шкала ролика и дорожки объектов одной ширины", async ({ page }) => {
  const { project, task, video } = await shortClip(page);
  // Дорожка появляется вместе с объектом — заводим его через API.
  await page.request.post(`/api/tasks/${task.id}/videos/${video.id}/tracks`, {
    data: { class_index: 0, frame_no: 0, geometry: { x: 10, y: 90, w: 60, h: 60 } },
  });
  const editor = await openEditor(page, project, task);

  // Линейка, служебные дорожки и дорожки объектов — одна сетка: полосы совпадают по краям,
  // иначе «объект появляется здесь» указывает не туда.
  const ruler = await editor.getByRole("slider", { name: "Кадр" }).boundingBox();
  const done = await editor.locator(".ve-sys .ve-l").first().boundingBox();
  const lane = await editor.locator(".ve-r[data-track-id] .ve-l").first().boundingBox();
  expect(ruler, "нет шкалы ролика").toBeTruthy();
  for (const [name, box] of [["размечено", done], ["объект", lane]] as const) {
    expect(Math.abs((box?.x ?? 0) - (ruler?.x ?? 0)), name).toBeLessThan(0.6);
    expect(Math.abs((box?.width ?? 0) - (ruler?.width ?? 0)), name).toBeLessThan(0.6);
  }
});

test("одиночные видны рисками на своей дорожке, щелчок — к кадру", async ({ page }) => {
  const { project, task, video } = await shortClip(page);

  // Два одиночных бокса на разных кадрах — через API, рисовать не нужно.
  const cls = await (
    await page.request.get(`/api/projects/${project.code}/classes`)
  ).json();
  const ci = cls.classes[0].class_index;
  for (const frameNo of [3, 11]) {
    const res = await page.request.put(
      `/api/tasks/${task.id}/videos/${video.id}/frames/${frameNo}/boxes`,
      { data: { boxes: [{ class_index: ci, x: 10, y: 10, w: 40, h: 30 }] } }
    );
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  const editor = await openEditor(page, project, task);
  const ticks = editor.locator(".ve-tick-s");
  await expect(ticks).toHaveCount(2);
  await expect(ticks.nth(0)).toHaveAttribute("aria-label", /кадр 3$/);

  // Риска — кнопка: по ней и переходят.
  await ticks.nth(1).dispatchEvent("pointerdown", { button: 0 });
  await expect.poll(() => uiFrame(editor)).toBe(11);
  await expect(editor.locator(".ve-pos")).toContainText(/кадр\s+11\s+из/);
  await expect(editor.locator(".ve-side .fe-obj")).toHaveCount(1);
});

test("одиночный объект превращается в трек и удаляется", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Правка заблокирована, пока кадр не показан: браузер стенда не разжимает H.264"
  );
  const { project, task, video } = await shortClip(page);
  const cls = await (
    await page.request.get(`/api/projects/${project.code}/classes`)
  ).json();
  const ci = cls.classes[0].class_index;
  await page.request.put(
    `/api/tasks/${task.id}/videos/${video.id}/frames/0/boxes`,
    { data: { boxes: [{ class_index: ci, x: 10, y: 10, w: 60, h: 40 }] } }
  );

  const editor = await openEditor(page, project, task);
  const frame = editor.locator(".mag-cv-frame canvas").first();
  await expect(async () => {
    expect(await drawn(frame)).toBeTruthy();
  }).toPass();
  const box = editor.locator(".mag-cv-hit").first();
  await expect(box).toBeVisible();

  // Правая кнопка на объекте — меню с превращением в трек.
  await box.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Сделать треком/ }).click();

  // Одиночный ушёл, трек появился — и у него есть дорожка.
  await expect(editor.locator(".ve-r[data-track-id]")).toHaveCount(1);
  const saved = await (
    await page.request.get(`/api/tasks/${task.id}/videos/${video.id}/annotations`)
  ).json();
  expect(saved.tracks).toHaveLength(1);
  expect(saved.singles).toHaveLength(0);

  // Теперь удалим трек из его строки справа — окно спрашивает подтверждение.
  await editor.locator(".ve-side").getByRole("button", { name: "Удалить трек" }).click();
  await page.getByRole("dialog", { name: /^Удалить трек/ }).getByRole("button", { name: "Удалить трек" }).click();
  await expect(editor.locator(".mag-cv-hit")).toHaveCount(0);

  const after = await (
    await page.request.get(`/api/tasks/${task.id}/videos/${video.id}/annotations`)
  ).json();
  expect(after.tracks).toHaveLength(0);
});

test("разметка закрывается и открывается заново из шапки редактора", async ({ page }) => {
  const { project, task, video } = await shortClip(page);
  const cls = await (await page.request.get(`/api/projects/${project.code}/classes`)).json();
  await page.request.put(`/api/tasks/${task.id}/videos/${video.id}/frames/4/boxes`, {
    data: { boxes: [{ class_index: cls.classes[0].class_index, x: 10, y: 10, w: 40, h: 30 }] },
  });
  const editor = await openEditor(page, project, task);

  // План считается с задержкой — кнопка оживает, когда есть что закрывать
  const close = editor.getByRole("button", { name: "Закрыть разметку" });
  await expect(close).toBeEnabled({ timeout: 15_000 });
  await close.click();
  const ask = page.getByRole("dialog", { name: "Закрыть разметку ролика?" });
  await expect(ask.getByText(/1 кадр уйдёт в таску/)).toBeVisible();
  await ask.getByRole("button", { name: "Закрыть разметку" }).click();

  await expect(editor.getByText(/Разметка закрыта: 1 кадр в таске/)).toBeVisible({ timeout: 30_000 });
  await expect(editor.getByText("разметка закрыта", { exact: true })).toBeVisible();
  const reopen = editor.getByRole("button", { name: "Открыть заново" });
  await expect(reopen).toBeVisible();

  await reopen.click();
  await expect(editor.getByRole("button", { name: "Закрыть разметку" })).toBeVisible();
  const detail = await (await page.request.get(`/api/tasks/${task.id}`)).json();
  expect(detail.videos[0].annotation_closed_at).toBeNull();
});

test("граница кадра и дорожек тянется и помнит высоту", async ({ page }) => {
  const { project, task } = await shortClip(page);
  const editor = await openEditor(page, project, task);
  const dock = editor.locator(".ve-dock");
  const before = (await dock.boundingBox())!.height;

  const grip = (await editor.locator(".ed-grip").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 4);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 120, { steps: 6 });
  await page.mouse.up();
  const tall = (await dock.boundingBox())!.height;
  expect(tall - before).toBeGreaterThan(100);

  // Высота — привычка человека: открыли заново — та же
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await reel(page).getByRole("button", { name: "Размечать ролик" }).click();
  await expect.poll(async () => Math.round((await dock.boundingBox())?.height ?? 0)).toBe(Math.round(tall));

  // Двойной щелчок — как было
  await editor.locator(".ed-grip").dblclick();
  await expect.poll(async () => Math.round((await dock.boundingBox())?.height ?? 0)).toBe(Math.round(before));
});
