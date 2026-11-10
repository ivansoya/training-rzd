// Проверяет настоящую очередь вкладки и карточки; API подменён, файлы на сервер не уходят.
// Запуск: BASE=http://127.0.0.1:5173 node tests/e2e/upload-cards.mjs
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = process.env.BASE || "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const code = "UPLOADPROGRESSCHECK01";
const created = new Date().toISOString();
const tasks = ["upload-a", "upload-b", "untouched"].map((id) => ({
  id, name: id, status: "queued", status_label: "На очереди", assignees: [], moves: [],
  target_dataset: null, created_at: created, status_at: created, last_at: created, last_box_at: null,
}));
const project = { id: "project", code, name: "Проверка загрузки", status: "ready", created_at: created };
const stats = Object.fromEntries(tasks.map((task) => [task.id, {
  counts: { total: 0, new: 0, skipped: 0, annotated: 0, empty: 0, deleted: 0, accepted: 0 },
  sources: { files: 0, cut: 0, uncut: 0, annotate: 0 },
  videos: { tracks: 0, boxes: 0, agent_done: 0, agent_left: 0 },
}]));
const summaryReads = { "upload-a": 0, "upload-b": 0, untouched: 0 };

try {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    let data;
    if (path === "/api/auth/me") data = {
      user: { id: "me", display_name: "Проверяющий", login: "check", hardware: null },
      projects: [{ ...project, role: "admin", role_label: "Администратор" }],
    };
    else if (path === `/api/projects/${code}`) data = {
      project, my_role: "admin", members: [], datasets: [], classes: [],
      stats: { images: 0, annotations: 0, size_bytes: 0, datasets: 0, classes: 0, tasks: tasks.length },
    };
    else if (path === `/api/projects/${code}/tasks`) data = { tasks, can_create: true, is_admin: true };
    else if (path === "/api/projects") data = { projects: [] };
    else if (/^\/api\/tasks\/[^/]+\/summary$/.test(path)) {
      const id = path.split("/")[3];
      summaryReads[id]++;
      data = stats[id];
    }
    else if (path === "/api/friends") data = { friends: [], incoming: [], outgoing: [] };
    else if (path === "/api/invitations") data = { invitations: [] };
    else if (path === "/api/tasks/questions-inbox") data = { items: [], total: 0 };
    else if (path === `/api/projects/${code}/tags`) data = { tags: [] };
    else return route.fulfill({ status: 503, json: { error: "Unavailable in upload check" } });
    return route.fulfill({ json: data });
  });
  await page.goto(`${base}/projects/${code}/tasks`);
  const card = (id) => page.locator(".tb-card", { hasText: id });
  await expect(card("upload-a").getByText("кадров пока нет", { exact: true })).toBeVisible();

  await page.evaluate(async () => {
    const uploads = await import("/src/components/mag/tasks/uploads.ts");
    const pending = {};
    const enqueue = (id, names) => uploads.enqueueUpload(id, names.map((name) => ({
      name, send: (pct) => new Promise((resolve, reject) => { pending[name] = { pct, resolve, reject }; }),
    }))).catch(() => undefined);
    window.uploadCheck = { uploads, pending, jobs: [
      enqueue("upload-a", ["first.mp4", "camera_close_2026-10-25_10-33-45-with-a-long-name.mp4", "last.mp4"]),
      enqueue("upload-b", ["queued.mp4"]),
    ] };
  });
  await expect.poll(() => page.evaluate(() => window.uploadCheck.uploads.uploadOf("upload-a")?.name)).toBe("first.mp4");
  const progress = card("upload-a").getByRole("status", { name: "Загрузка файлов" });
  const queued = card("upload-b").getByRole("status", { name: "Загрузка файлов" });
  await expect(progress).toBeVisible({ timeout: 2000 });
  await expect(queued).toContainText("В очереди");
  await expect(card("untouched").getByRole("status", { name: "Загрузка файлов" })).toHaveCount(0);

  stats["upload-a"].sources.cut = 1;
  stats["upload-a"].sources.uncut = 1;
  const beforeLanding = summaryReads["upload-a"];
  await page.evaluate(() => window.uploadCheck.pending["first.mp4"].resolve("ok"));
  await expect.poll(() => page.evaluate(() => window.uploadCheck.uploads.uploadOf("upload-a")?.done)).toBe(1);
  await page.evaluate(() => window.uploadCheck.pending["camera_close_2026-10-25_10-33-45-with-a-long-name.mp4"].pct(0.08));
  await expect(progress).toContainText("1 из 3");
  await expect(progress).toContainText("8 %");
  await expect(progress).toContainText("camera_close_2026-10-25_10-33-45-with-a-long-name.mp4");
  await expect.poll(() => summaryReads["upload-a"]).toBeGreaterThan(beforeLanding);
  await expect(card("upload-a").locator(".tb-src")).toContainText("1 ролик");
  await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "36");

  await page.evaluate(() => window.uploadCheck.pending["camera_close_2026-10-25_10-33-45-with-a-long-name.mp4"].pct(0.6));
  await expect(progress).toContainText("60 %");
  await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "53");
  // Уход с доски не прерывает загрузку, возвращение восстанавливает тот же прогресс.
  await page.locator('a[href="/"]').first().click();
  await page.goBack();
  await expect(progress).toContainText("60 %");
  await expect(queued).toContainText("В очереди");

  await page.evaluate(() => window.uploadCheck.pending["camera_close_2026-10-25_10-33-45-with-a-long-name.mp4"].pct(1));
  await expect(progress).toContainText("Обрабатываю на сервере");
  await expect(progress).toBeVisible();
  await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "67");
  await expect.poll(() => progress.getByRole("progressbar").evaluate((el) =>
    Math.round(el.firstElementChild.getBoundingClientRect().width / el.getBoundingClientRect().width * 100))).toBe(67);
  await mkdir(new URL("./test-results/", import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("./test-results/upload-cards.png", import.meta.url)), fullPage: true });
  for (const width of [1044, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(progress).toBeVisible();
    const overflow = await card("upload-a").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow, `Карточка переполнена при ширине ${width}`).toBe(false);
  }

  await page.evaluate(async () => {
    const { pending, uploads } = window.uploadCheck;
    pending["camera_close_2026-10-25_10-33-45-with-a-long-name.mp4"].resolve("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending["last.mp4"].resolve("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending["queued.mp4"].reject(new Error("Не удалось загрузить queued.mp4"));
    await Promise.all(window.uploadCheck.jobs);
    if (uploads.uploading(uploads.uploadOf("upload-a"))) throw new Error("Загрузка не завершилась");
  });
  await expect(progress).toHaveCount(0);
  await expect(queued).toHaveCount(0);
  await expect(card("upload-b")).toContainText("Не удалось загрузить queued.mp4");
  expect(errors).toEqual([]);
  console.log("PASS: прогресс карточек обновляется, очередь видна, счётчики перечитываются, возврат и завершение работают; ошибка видна; переполнения нет");
} catch (error) {
  console.error("Browser errors:", errors);
  console.error("Page:", await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
