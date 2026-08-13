import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

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

function tag(): string {
  return "test-" + Math.random().toString(16).slice(2, 10);
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

test("видео размечается треком и объект остаётся на сервере", async ({ page }) => {
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
  const video = await upload.json();

  // --- дальше только интерфейс ---
  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  await page.getByRole("button", { name: /Источники/ }).click();

  const source = page.locator(".mag-src-video");
  await expect(source).toBeVisible();
  await expect(source.getByText("размечается")).toBeVisible();

  await page.getByRole("button", { name: "Размечать" }).click();

  const editor = page.getByRole("dialog", { name: "Разметка видео" });
  await expect(editor).toBeVisible();
  await expect(editor.getByText(/кадр 0 \/ 29/)).toBeVisible();

  // Кадр приходит с сервера картинкой — без неё рисовать не по чему.
  const frame = editor.locator(".mag-cv-frame img").first();
  await expect(frame).toBeVisible();
  await expect(async () => {
    expect(await frame.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  }).toPass();

  await editor.getByTitle(/Трек-бокс/).click();

  const box = await frame.boundingBox();
  if (!box) throw new Error("Кадр не отрисовался");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.75, { steps: 12 });
  await page.mouse.up();

  // Объект появился в списке слева — значит сервер его принял и отдал обратно.
  await expect(editor.locator(".mag-ved-obj")).toHaveCount(1);

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
  await page.getByRole("button", { name: /Источники/ }).click();
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
  await page.getByRole("button", { name: /Источники/ }).click();
  await page.setInputFiles('input[type="file"][accept="video/*"]', SAMPLE);

  const dialog = page.getByRole("dialog", { name: "Что делать с видео" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Нарезать на кадры")).toBeVisible();
  await expect(dialog.getByText("Размечать видео")).toBeVisible();
});

function readSample(): Buffer {
  return readFileSync(SAMPLE);
}
