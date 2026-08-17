import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

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

const MAILPIT = process.env.TEST_MAILPIT_URL || "http://mailpit:8025";
const SAMPLE = process.env.TEST_SAMPLE_VIDEO || "/tmp/magistral-sample-30f.mp4";

const LONG_SAMPLE = process.env.TEST_SAMPLE_LONG || "/tmp/magistral-sample-300f.mp4";

function tag(): string {
  return "test-" + Math.random().toString(16).slice(2, 10);
}

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

function readLongSample(): Buffer {
  return readFileSync(LONG_SAMPLE);
}

/** Проект, класс, таска и загруженный длинный ролик — всё через API. */
async function longClip(page: Page) {
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
      file: { name: "sample-300f.mp4", mimeType: "video/mp4", buffer: readLongSample() },
      mode: "annotate",
    },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  return { project, task, video: await upload.json() };
}

/** Выбрать ступень качества в меню под значком. */
async function pickQuality(editor: Locator, label: string) {
  await editor.getByRole("button", { name: "Качество" }).click();
  await editor.locator(".mag-ved-quality-menu").getByText(label, { exact: true }).click();
}

async function openEditor(page: Page, project: { code: string }, task: { id: string }) {
  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  await page.getByRole("button", { name: /^Видео/ }).click();
  await page.locator(".g-block").first().getByRole("button", { name: "Размечать" }).click();
  const editor = page.getByRole("dialog", { name: "Разметка видео" });
  await expect(editor).toBeVisible();
  return editor;
}

/** Ссылка подтверждения из письма. Ходим в Mailpit, а не в базу: письмо —
 *  часть обещания продукта, и пусть оно проверяется вместе со всем прочим. */
async function confirmLink(request: APIRequestContext, email: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(email)}`);
    if (res.ok()) {
      const body = await res.json();
      const first = body.messages?.[0];
      if (first) {
        const full = await request.get(`${MAILPIT}/api/v1/message/${first.ID}`);
        const text = (await full.json()).Text || "";
        const match = text.match(/https?:\/\/\S*\/confirm\/[A-Za-z0-9_-]+/);
        if (match) return match[0];
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Письмо для ${email} не пришло`);
}

async function signIn(page: Page): Promise<string> {
  const login = tag();
  const email = `${login}@example.test`;
  const password = "Test-Passw0rd";

  const reg = await page.request.post("/api/auth/register", {
    data: { email, login, display_name: "Сквозной разметчик", password },
  });
  expect(reg.ok(), await reg.text()).toBeTruthy();

  const link = await confirmLink(page.request, email);
  await page.goto(new URL(link).pathname);

  // Подтверждение идёт запросом со страницы, и по успеху она уводит на главную.
  // Ждём именно ухода: иначе следующий шаг обгонит незавершённый запрос.
  await expect(page).not.toHaveURL(/\/confirm\//, { timeout: 20_000 });

  // Сервер открывает сессию сразу на подтверждении — отдельный вход не нужен.
  const me = await page.request.get("/api/auth/me");
  expect(me.ok(), await me.text()).toBeTruthy();
  expect((await me.json()).user.login).toBe(login);
  return login;
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
  await page.getByRole("button", { name: /^Видео/ }).click();

  const card = page.locator(".g-block").first();
  await expect(card).toBeVisible();
  await expect(card.getByText("размечается")).toBeVisible();
  // Ролик ещё не закрыт, поэтому кадров в таске нет, а работа уже видна.
  await expect(card.getByText(/объектов ведётся/)).toBeVisible();

  await card.getByRole("button", { name: "Размечать" }).click();

  const editor = page.getByRole("dialog", { name: "Разметка видео" });
  await expect(editor).toBeVisible();
  await expect(editor.locator(".mag-ed-cnt")).toContainText(/кадр\s+0\s*\/\s*29/);

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
  await page.getByRole("button", { name: /^Видео/ }).click();
  await page.locator(".g-block").first().getByRole("button", { name: "Размечать" }).click();
  const editor = page.getByRole("dialog", { name: "Разметка видео" });
  await expect(editor).toBeVisible();
  const frame = editor.locator(".mag-cv-frame canvas").first();
  await expect(async () => {
    expect(await drawn(frame)).toBeTruthy();
  }).toPass();

  await editor.getByTitle(/Трек-бокс/).click();

  const box = await frame.boundingBox();
  if (!box) throw new Error("Кадр не отрисовался");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.75, { steps: 12 });
  await page.mouse.up();

  // Объект появился и в списке слева, и дорожкой внизу — значит сервер его
  // принял и отдал обратно.
  await expect(editor.locator(".mag-ved-obj")).toHaveCount(1);
  await expect(editor.locator(".g-lane")).toHaveCount(1);

  const saved = await (
    await page.request.get(`/api/tasks/${task.id}/videos/${video.id}/annotations`)
  ).json();
  expect(saved.tracks).toHaveLength(1);
  expect(saved.tracks[0].keys).toHaveLength(1);
  expect(saved.tracks[0].keys[0].frame_no).toBe(0);

  const detail = await (await page.request.get(`/api/tasks/${task.id}`)).json();
  expect(detail.videos[0].tracks).toBe(1);
});

test("нарезаемое видео открывает нарезку, а не редактор разметки", async ({ page }) => {
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
  await page.getByRole("button", { name: /^Видео/ }).click();
  await expect(page.getByText("нарезка")).toBeVisible();
  await page.getByRole("button", { name: "Нарезать" }).click();
  await expect(page.getByRole("dialog", { name: "Разметка видео" })).toHaveCount(0);
});

test("режим спрашивают до отправки файла", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/projects", { data: { name: tag() } })
  ).json();
  const task = await (
    await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })
  ).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });

  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  await page.getByRole("button", { name: /^Видео/ }).click();
  await page.setInputFiles('input[type="file"][accept="video/*"]', SAMPLE);

  const dialog = page.getByRole("dialog", { name: "Что делать с видео" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Нарезать на кадры")).toBeVisible();
  await expect(dialog.getByText("Размечать видео")).toBeVisible();
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
  await page.getByRole("button", { name: /^Видео/ }).click();
  await page.getByRole("button", { name: "Закрыть разметку" }).click();

  // Кадры появляются в таске до всякой сдачи — это обычные кадры.
  await expect(page.getByText(/Разметка .* закрыта/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("разметка закрыта")).toBeVisible();

  await page.getByRole("button", { name: /^Кадры/ }).click();
  const block = page.locator(".g-block").first();
  await expect(block).toBeVisible();
  await expect(block.getByText("из разметки видео")).toBeVisible();
  await expect(block.getByRole("button", { name: "Размечать" })).toBeVisible();
});

test("шаг стрелкой показывает соседний кадр, а не соседний примерно", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page);
  const editor = await openEditor(page, project, task);

  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(0);

  const forward = editor.getByTitle(/Кадр вперёд/);
  for (const expected of [1, 2, 3]) {
    await forward.click();
    await expect.poll(() => frameMark(editor), { timeout: 15_000 }).toBe(expected);
  }

  const back = editor.getByTitle(/Кадр назад/);
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
  await editor.locator(".mag-ved-scrub").fill("200");
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(200);

  // Назад через две границы перегонов — туда, где уже были.
  await editor.locator(".mag-ved-scrub").fill("5");
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
  await editor.locator(".mag-ved-scrub").fill("118");
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(118);

  const forward = editor.getByTitle(/Кадр вперёд/);
  for (const expected of [119, 120, 121]) {
    await forward.click();
    await expect.poll(() => frameMark(editor), { timeout: 20_000 }).toBe(expected);
  }

  await editor.getByTitle(/Кадр назад/).click();
  await expect.poll(() => frameMark(editor), { timeout: 20_000 }).toBe(120);
});

test("исходное качество показывает тот же кадр крупнее", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page);
  const editor = await openEditor(page, project, task);
  await editor.locator(".mag-ved-scrub").fill("77");
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(77);

  const canvas = editor.locator(".mag-cv-frame canvas").first();
  const before = await canvas.evaluate((el: HTMLCanvasElement) => el.width);

  await pickQuality(editor, "Исходное");
  await expect
    .poll(() => canvas.evaluate((el: HTMLCanvasElement) => el.width), { timeout: 60_000 })
    .toBeGreaterThan(before);

  // Кадр обязан остаться тем же: иначе «резкость» уводила бы разметчика.
  expect(await frameMark(editor)).toBe(77);
});

test("проигрывание не срывает декодер", async ({ page }) => {
  test.skip(
    !(await decodesH264(page)),
    "Браузер стенда не разжимает H.264: проверка идёт API-тестом"
  );
  const { project, task } = await longClip(page);
  const editor = await openEditor(page, project, task);
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(0);

  const play = editor.getByTitle(/Играть/);
  await play.click();
  await page.waitForTimeout(3000);
  await play.click();

  // Ролик и правда шёл, а не стоял на месте.
  const at = Number(
    (await editor.locator(".mag-ved-time").first().innerText()).split("·")[1].trim()
  );
  expect(at).toBeGreaterThan(10);

  // Ни одного срыва разжатия: раньше здесь падало «нужен опорный кадр» —
  // декодер после слива не принимал обычный кадр, картинка застывала, а
  // время продолжало идти.
  await expect(editor.locator(".mag-ed-err")).toHaveCount(0);

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
  await editor.locator(".mag-ved-scrub").fill("100");
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(100);

  await editor.getByTitle(/Играть/).click();
  // Пока идёт ролик, время не имеет права убегать от картинки: раньше полоса
  // бежала вперёд, кадр замирал, и кусок ролика проходил незамеченным.
  const behind: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    await page.waitForTimeout(200);
    const ui = Number(
      (await editor.locator(".mag-ved-time").first().innerText()).split("·")[1].trim()
    );
    behind.push(ui - (await frameMark(editor)));
  }
  await editor.getByTitle(/Играть/).click();
  expect(Math.max(...behind), `отставание картинки по замерам: ${behind}`).toBeLessThanOrEqual(2);

  const at = Number(
    (await editor.locator(".mag-ved-time").first().innerText()).split("·")[1].trim()
  );
  // Границу прошли — иначе тест ничего не проверил.
  expect(at).toBeGreaterThan(120);
  await expect(editor.locator(".mag-ed-err")).toHaveCount(0);
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
  const before = await editor.locator(".mag-ved-scrub").boundingBox();

  await editor.locator(".mag-ved-scrub").fill("250");

  const busy = editor.locator(".mag-ved-busy");
  await expect(busy).toBeVisible();

  const during = await editor.locator(".mag-ved-scrub").boundingBox();
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
  const { project, task } = await longClip(page);
  const editor = await openEditor(page, project, task);
  await editor.locator(".mag-ved-scrub").fill("150");
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(150);

  // Две ступени подряд: раньше перегон прежнего качества дописывался в кэш
  // уже после переключения, ожидание застывало и таймлайн переставал двигать
  // кадр — ползунок ездит, картинка стоит.
  await pickQuality(editor, "Исходное");
  await pickQuality(editor, "360p");

  await expect.poll(() => frameMark(editor), { timeout: 60_000 }).toBe(150);
  await expect(editor.locator(".mag-ed-err")).toHaveCount(0);

  // И редактор жив: шаг вперёд показывает следующий кадр.
  await editor.getByTitle(/Кадр вперёд/).click();
  await expect.poll(() => frameMark(editor), { timeout: 30_000 }).toBe(151);
});

test("кнопки плеера не меняют размер и не двигают таймлайн", async ({ page }) => {
  const { project, task } = await shortClip(page);
  const editor = await openEditor(page, project, task);

  const scrub = editor.locator(".mag-ved-scrub");
  const before = await scrub.boundingBox();

  // ▶ превращается в ⏸ — символы разной ширины, и раньше от этого ехал ряд.
  const play = editor.locator(".mag-ved-transport .mag-ed-btn").first();
  await play.click();
  const during = await scrub.boundingBox();
  await play.click();

  expect(Math.abs((during?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(1);
  expect(Math.abs((during?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(1);

  // Скорости тоже одной ширины: ¼ и 2× сами по себе разные.
  const widths = await editor
    .locator(".mag-ved-speed button")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  expect(new Set(widths).size, `ширины кнопок скорости: ${widths}`).toBe(1);
});

test("справка подсвечивает управление и перечисляет клавиши", async ({ page }) => {
  const { project, task } = await shortClip(page);
  const editor = await openEditor(page, project, task);

  // Всплывающих подсказок на органах управления не осталось — они мешали.
  for (const area of [".mag-ed-head", ".mag-ed-rail", ".mag-ved-bottom"]) {
    expect(await editor.locator(`${area} [title]`).count(), area).toBe(0);
  }

  await editor.getByRole("button", { name: "справка" }).click();
  await expect(editor.locator(".mag-ed-dim")).toBeVisible();

  const panel = editor.locator(".mag-ed-help");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Играть или остановить")).toBeVisible();
  await expect(panel.getByText("Трек-бокс: объект, живущий во времени")).toBeVisible();
  await expect(panel.locator("kbd").filter({ hasText: "Пробел" })).toBeVisible();

  // Органы управления помечены — их подсвечивает справка.
  expect(await editor.locator("[data-help]").count()).toBeGreaterThan(8);

  await editor.locator(".mag-ed-dim").click();
  await expect(panel).toHaveCount(0);
});

test("шкала ролика и дорожки объектов одной ширины", async ({ page }) => {
  const { project, task } = await shortClip(page);
  const editor = await openEditor(page, project, task);

  // Ползунок и дорожки стоят в одной сетке: их полосы обязаны совпадать
  // по краям, иначе «объект появляется здесь» указывает не туда.
  const ruler = await editor.locator(".mag-ved-ruler .g-lane-track").boundingBox();
  expect(ruler, "нет шкалы ролика").toBeTruthy();

  // Дорожки появляются вместе с объектами; пока их нет, сверяем саму сетку.
  const name = await editor.locator(".mag-ved-ruler .g-lane-name").boundingBox();
  const state = await editor.locator(".mag-ved-ruler .g-lane-state").boundingBox();
  expect(name?.width).toBeGreaterThan(0);
  expect(state?.width).toBeGreaterThan(0);

  // Сверяем с внутренней областью дорожки: метки треков лежат внутри её
  // рамки, значит и шкала ролика обязана начинаться там же.
  const inner = await editor
    .locator(".mag-ved-ruler .g-lane-track")
    .evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { x: box.x + el.clientLeft, width: el.clientWidth };
    });
  const scrub = await editor.locator(".mag-ved-scrub").boundingBox();
  expect(Math.abs((scrub?.x ?? 0) - inner.x)).toBeLessThan(0.6);
  expect(Math.abs((scrub?.width ?? 0) - inner.width)).toBeLessThan(0.6);
});

test("окно объектов показывает, на каких кадрах они есть", async ({ page }) => {
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
  await editor.getByRole("button", { name: "объекты" }).click();

  const panel = editor.locator(".mag-ed-objects");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".mag-ed-objects-frames button")).toHaveText(["3", "11"]);

  // Кадр объекта — кнопка: по ней и переходят.
  await panel.locator(".mag-ed-objects-frames button", { hasText: "11" }).click();
  await expect(editor.locator(".mag-ed-cnt")).toContainText(/кадр\s+11\s*\//);
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
  const box = editor.locator(".mag-cv-box").first();
  await expect(box).toBeVisible();

  // Правая кнопка на объекте — меню с превращением в трек.
  await box.click({ button: "right" });
  await page.getByText("Сделать треком").click();

  // Одиночный ушёл, трек появился — и у него есть дорожка.
  await expect(editor.locator(".g-lane")).toHaveCount(2); // шкала ролика + дорожка
  const saved = await (
    await page.request.get(`/api/tasks/${task.id}/videos/${video.id}/annotations`)
  ).json();
  expect(saved.tracks).toHaveLength(1);
  expect(saved.singles).toHaveLength(0);

  // Теперь удалим трек через то же меню.
  await editor.locator(".mag-cv-box").first().click({ button: "right" });
  await page.getByText("Удалить трек целиком").click();
  await expect(editor.locator(".mag-cv-box")).toHaveCount(0);

  const after = await (
    await page.request.get(`/api/tasks/${task.id}/videos/${video.id}/annotations`)
  ).json();
  expect(after.tracks).toHaveLength(0);
});
