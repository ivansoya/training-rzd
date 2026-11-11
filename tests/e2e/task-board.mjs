// Настоящая доска и обзор, API изолирован: рабочие таски не изменяются.
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const base = process.env.BASE || "http://127.0.0.1:5181";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [], unknown = new Set(), moves = [];
page.on("pageerror", (e) => errors.push(e.message));
const code = "TASKBOARDCHECK", created = "2026-11-11T09:00:00Z";
const project = { id: "project", code, name: "Проверка карточек", status: "ready", created_at: created };
const person = { id: "me", display_name: "Соя Иван" };
const task = (id, status, name) => ({ id, status, name, assignees: [person], created_at: created, status_at: created,
  last_at: created, last_box_at: null, moves: ["queued", "in_progress", "done", "updating"], target_dataset: null });
const tasks = [task("drag", "in_progress", "Карточка для переноса"), task("updated", "updating", "Разметка левой камеры"),
  ...Array.from({ length: 4 }, (_, i) => task(`tall-${i}`, "done", `Сданная таска ${i + 1}`))];
const counts = { total: 0, new: 0, skipped: 0, annotated: 0, empty: 0, deleted: 0, accepted: 0 };
let pending = false;
const summary = (id) => ({ counts: id.startsWith("tall-") ? { ...counts, total: 420, annotated: 420, accepted: 420 } : counts, sources: { files: 0, cut: 0, uncut: 0, annotate: 1 },
  videos: { tracks: 0, boxes: 520, agent_done: 420, agent_left: id === "updated" && pending ? 5 : 0 },
  progress: { annotated: 420, changed: id === "updated" ? 12 : 0 } });
const out = new URL("./test-results/task-board/", import.meta.url);
try {
  await mkdir(out, { recursive: true });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    let data;
    if (path === "/api/auth/me") data = { user: { ...person, login: "check", hardware: null }, projects: [{ ...project, role: "admin", role_label: "Администратор" }] };
    else if (path === `/api/projects/${code}`) data = { project, my_role: "admin", members: [], datasets: [{ id: "dataset", name: "Кадры камер", images: 1 }], classes: [], stats: { images: 0, annotations: 0, size_bytes: 0, datasets: 0, classes: 0, tasks: tasks.length } };
    else if (path === `/api/projects/${code}/tasks`) data = { tasks, can_create: true, is_admin: true };
    else if (/\/api\/tasks\/[^/]+\/summary$/.test(path)) data = summary(path.split("/")[3]);
    else if (/\/api\/tasks\/[^/]+\/status$/.test(path) && request.method() === "POST") {
      const id = path.split("/")[3], body = request.postDataJSON();
      moves.push({ id, ...body });
      const t = tasks.find((t) => t.id === id); t.status = body.status;
      data = t;
    }
    else if (path === `/api/projects/${code}/overview`) data = { updated_at: null, frames: { total: 0, week: 0, series: [] },
      annotated: { count: 0, empty: 0, share: [] }, boxes: { total: 0, series: [] }, classes: { declared: 0, used: 0, rows: [] }, best: null, latest_run: null, activity: [] };
    else if (path.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: ": test\n\n" });
    else if (path.endsWith("/live")) data = { runs: [] };
    else if (path === "/api/gpu") data = { staff: false, manage: false, level: null, cards: [], devices: [], cpu: { slots: 1, busy: 0, holders: [] }, queue: { mine: [], ahead: 0, total: 0, queue: [] }, live: { used: 0, soft: 1, hard: 1, peak: 0 }, settings: {} };
    else if (path === "/api/auto/sessions") data = { sessions: [] };
    else if (path === "/api/tasks/questions-inbox") data = { items: [], total: 0 };
    else if (path === "/api/friends") data = { friends: [], incoming: [], outgoing: [] };
    else if (path === "/api/invitations") data = { invitations: [] };
    else if (path === "/api/projects") data = { projects: [] };
    else { unknown.add(path); return route.fulfill({ status: 404, json: { error: "Unknown test route" } }); }
    return route.fulfill({ json: data });
  });
  await page.goto(`${base}/projects/${code}/tasks`);
  const updated = page.locator('.tb-card[href$="/updated"]');
  await expect(updated).toContainText("размечено 420");
  await expect(updated).toContainText("изменено 12");
  await expect(updated.locator(".ui-stack")).toHaveCount(0);
  const queued = page.getByRole("region", { name: "На очереди", exact: true });
  const dragCard = page.locator('.tb-card[href$="/drag"]');
  await expect(dragCard).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((a) => a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  });
  // Воспроизводит исходный дефект геометрии по запросу, не меняя исходники.
  if (process.env.REPRO_OLD_HEIGHT) await page.addStyleTag({ content: ".tb { align-items:start } .tb-col { min-height:0 }" });
  const boardBox = await page.locator(".tb").boundingBox();
  const colBox = await queued.boundingBox();
  const dropY = Math.min(boardBox.y + boardBox.height - 30, 800);
  expect(colBox.y + colBox.height, "Пустая колонка охватывает нижнюю часть доски").toBeGreaterThan(dropY);
  // Настоящее перетаскивание мышью в пустое место далеко ниже заголовка.
  const source = await dragCard.boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + 25);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 - 20, source.y + 35, { steps: 8 });
  await page.mouse.move(colBox.x + colBox.width / 2, dropY, { steps: 20 });
  await page.mouse.up();
  await expect(queued.locator('.tb-card[href$="/drag"]')).toBeVisible();
  expect(moves).toEqual([{ id: "drag", status: "queued" }]);
  await page.screenshot({ path: fileURLToPath(new URL("board.png", out)), fullPage: true });
  pending = true;
  await page.reload();
  await expect(updated.locator(".ui-stack")).toHaveCount(1);
  await expect(updated).toContainText("5 ждут проверки");
  pending = false;
  await page.goto(`${base}/projects/${code}`);
  const overview = page.locator(".ov-tasks li").filter({ hasText: "Разметка левой камеры" });
  await expect(overview).toContainText("размечено 420");
  await expect(overview).toContainText("изменено 12");
  await expect(overview.locator(".ui-stack")).toHaveCount(0);
  await page.screenshot({ path: fileURLToPath(new URL("overview.png", out)), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(overview).toContainText("изменено 12");
  expect(await overview.locator(".tb-line").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(errors).toEqual([]); expect([...unknown]).toEqual([]);
  console.log("PASS: full-column native drop; current/changed counts on board and overview; pending bar; 1024px readability");
} catch (e) {
  console.error({ url: page.url(), errors, unknown: [...unknown], text: (await page.locator("body").innerText()).slice(0, 2000) });
  throw e;
} finally { await browser.close(); }
