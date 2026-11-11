// Реальная страница; все API изолированы, рабочие таски не меняются.
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const base = process.env.BASE || "http://127.0.0.1:5181";
const out = "tests/e2e/test-results/task-agent-status";
const created = "2026-11-11T09:00:00Z", taskId = "agent-status-test", code = "AGENTSTATUSCHECK00001";
const project = { id: "project", code, name: "Искра", status: "ready", created_at: created };
const classes = Array.from({ length: 14 }, (_, i) => ({ name: `Класс ${i + 1}`, boxes: 20, frames: 20, max: 1,
  conf: { median: 0.8, min: 0.5, max: 0.9, hist: [0, 0, 0, 0, 0, 2, 3, 4, 10, 1] }, size: [40, 60], counts: Array(20).fill(1) }));
const segments = Object.fromEntries(classes.map((c) => [c.name, [[0, 1999, 20]]]));
const videos = Array.from({ length: 45 }, (_, i) => ({ id: `video-${String(i).padStart(2, "0")}`, file_name: `camera_close_2026-10-31_${String(i).padStart(2, "0")}.mp4`, mode: "cut",
  frames: 0, fresh: 0, accepted: 0, tracks: 0, tag_ids: [], segments: [], width: 1920, height: 1080, size_bytes: 155400000,
  duration_ms: 80000, frame_count: 2000, fps: 25, prepare: { ready: true, busy: false, error: null }, created_at: created }));
const scouts = Object.fromEntries(videos.map((v) => [v.id, { file_name: v.file_name, agent: "Искра", step: 100, gap_s: 1, last_frame: 1999, fps: 25, segments, created_at: created }]));
const run = { id: "run", status: "running", processed: 420, total: 900, stats: { plan: videos.map(() => 20), completed_videos: videos.slice(0, 20).map((v) => v.id) },
  agent: "Искра · YOLO · все 14 классов (тест)", version: 2, sources: [], videos: videos.map((v) => v.id), mode: "scout", rate: 2, error: null, queue_reason: null, created_at: created, finished_at: null,
  parallel: { count: 8, pending: 17, copies: Array.from({ length: 8 }, (_, i) => ({ id: `copy-${i}`, slot: i + 1, status: "running", processed: 30,
    item_processed: 10, item_total: 20, current: videos[20 + i].file_name, mode: "scout", videos: [videos[20 + i].id], sources: [], rate: 2, stats: { cursor: [0, 1000], plan: [20] } })) } };
const counts = { total: 0, new: 0, annotated: 0, empty: 0, skipped: 0, deleted: 0, accepted: 0, reviewed: 0, agent: 0 };
let releaseStats, releaseContext, releaseRuns;
const statsGate = new Promise((r) => { releaseStats = r; });
const contextGate = new Promise((r) => { releaseContext = r; });
const runsGate = new Promise((r) => { releaseRuns = r; });
let statsInFlight = 0, maxStatsInFlight = 0, contextRequests = 0;
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await mkdir(out, { recursive: true });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    let data;
    if (/\/(thumb|file|preview|strip)$/.test(path)) return route.fulfill({ status: 204 });
    if (path === "/api/auth/me") data = { user: { id: "me", display_name: "Проверка", login: "check", hardware: null }, projects: [{ ...project, role: "admin", role_label: "Администратор" }] };
    else if (path === `/api/projects/${code}`) data = { project, my_role: "admin", members: [], datasets: [], classes: [], stats: {} };
    else if (path === `/api/tasks/${taskId}`) data = { id: taskId, name: "Разведка камер Искры", status: "in_progress", status_label: "В работе", project,
      is_admin: true, rights: { edit: true, fill: true, tag_frames: true, assign: true, moves: [] }, assignees: [], target_dataset: { id: null, name: "Искра" },
      created_at: created, status_at: created, created_by: "Проверка", tags: [], videos, sources: {} };
    else if (path.endsWith("/counts")) data = { counts, by_source: {}, classes: [], from_files: 0 };
    else if (path.endsWith("/events")) data = { events: [] };
    else if (path.endsWith("/questions")) data = { questions: [], can_ask: true };
    else if (path === `/api/agents/tasks/${taskId}`) { contextRequests++; await contextGate; data = { agents: [], classes: [], mappings: {}, sources: {}, runs: [run], videos: [], can_run: true, resources: { cards: [], queued: 0 } }; }
    else if (path === `/api/agents/tasks/${taskId}/runs`) { await runsGate; data = { runs: [run] }; }
    else if (path === `/api/agents/tasks/${taskId}/scouts`) data = { scouts };
    else if (path.includes(`/scouts/`)) {
      statsInFlight++; maxStatsInFlight = Math.max(maxStatsInFlight, statsInFlight);
      await statsGate;
      const id = path.split("/").at(-1); statsInFlight--;
      data = { ...scouts[id], version: 2, checked: Array.from({ length: 20 }, (_, i) => i * 100), with_hits: 20, boxes: 280,
        max: 14, max_at: 0, per_frame: Array(20).fill(14), classes, frames: {}, mapped: {} };
    }
    else if (path.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: ": test\n\n" });
    else if (path.endsWith("/live")) data = { runs: [] };
    else if (path === "/api/gpu") data = { staff: false, manage: false, cards: [], devices: [], cpu: { slots: 1, busy: 0, holders: [] }, queue: { mine: [], ahead: 0, total: 0, queue: [] }, live: {}, settings: {} };
    else if (path.endsWith("/tags")) data = { tags: [] };
    else if (path.endsWith("/classes")) data = { classes: [] };
    else if (path === "/api/auto/sessions") data = { sessions: [] };
    else if (path === "/api/tasks/questions-inbox") data = { items: [], total: 0 };
    else if (path === "/api/friends") data = { friends: [], incoming: [], outgoing: [] };
    else if (path === "/api/invitations") data = { invitations: [] };
    else return route.fulfill({ status: 404, json: { error: "API isolated" } });
    return route.fulfill({ json: data });
  });
  await page.goto(`${base}/projects/${code}/tasks/${taskId}`);
  if (!process.env.BASELINE) await expect(page.locator(".ar-loading")).toContainText("Загружаем состояние работы агента");
  await page.getByRole("button", { name: "Разведка", exact: true }).click();
  const modal = page.locator(".ag-ov");
  if (process.env.BASELINE) {
    releaseStats(); releaseContext(); releaseRuns();
    await expect(modal.locator(".ag-ov-item")).toHaveCount(46);
    await modal.locator(".ag-ov-item").nth(1).click();
    const sizes = await modal.evaluate((el) => Object.fromEntries([".ag-ov-list", ".ag-ov-pane"].map((s) => { const e = el.querySelector(s); return [s, { height: e.clientHeight, content: e.scrollHeight }]; })));
    console.log("baseline", JSON.stringify(sizes));
    expect(sizes[".ag-ov-list"].content).toBeGreaterThan(sizes[".ag-ov-list"].height);
    await modal.locator(".ag-ov-list").evaluate((e) => { e.scrollTop = 500; });
    expect(await modal.locator(".ag-ov-list").evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  } else {
    await expect(modal.getByRole("status")).toContainText("Загружаем разведку");
    await page.screenshot({ path: `${out}/loading.png` });
    releaseRuns();
    await expect(page.locator(".ar-bar")).toBeVisible(); // полный контекст всё ещё заблокирован
    releaseContext(); releaseStats();
    await expect(modal.getByRole("status")).toHaveCount(0);
    await expect(modal.locator(".ag-ov-item")).toHaveCount(46);
    expect(maxStatsInFlight).toBeLessThanOrEqual(4);
    await modal.locator(".ag-ov-item").nth(1).click();
    await expect(modal.locator(".ag-tl-main")).toBeVisible();
    await expect(modal.locator(".ag-tl-main svg rect")).not.toHaveCount(0);
    await modal.locator(".ag-tl-main .ag-stats-strip").hover();
    await page.keyboard.down("Control"); await page.mouse.wheel(0, -100); await page.keyboard.up("Control");
    await expect(modal.locator(".ag-tl-win")).toContainText("окно");
    await modal.getByRole("button", { name: "Весь ролик", exact: true }).click();
    await modal.locator(".ag-tl-main .ag-stats-strip").hover(); await page.mouse.wheel(0, 400);
    await expect.poll(() => modal.locator(".ag-ov-pane").evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
    await modal.locator(".ag-ov-pane").evaluate((e) => { e.scrollTop = 0; });
    await expect(modal.locator(".ag-stats-table")).toBeVisible();
    expect(await modal.locator(".ag-tl").evaluate((e) => !!(e.compareDocumentPosition(document.querySelector(".ag-stats-table")) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await modal.getByRole("button", { name: "Скрыть таблицу", exact: true }).click();
    await expect(modal.locator(".ag-stats-table")).toHaveCount(0);
    await modal.getByRole("button", { name: "Скрыть дорожки классов", exact: true }).click();
    await expect(modal.locator(".ag-tl-lanes")).toHaveCount(0);
    await expect(modal.locator(".ag-tl-main")).toBeVisible();
    await modal.getByRole("button", { name: "Показать дорожки классов", exact: true }).click();
    await modal.getByRole("button", { name: "Показать таблицу", exact: true }).click();
    for (const selector of [".ag-ov-list", ".ag-ov-pane"]) {
      const el = modal.locator(selector);
      await el.evaluate((e) => { e.scrollTop = 500; });
      expect(await el.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
    }
    await modal.locator(".ag-ov-list").evaluate((e) => { e.scrollTop = 0; });
    await modal.locator(".ag-ov-pane").evaluate((e) => { e.scrollTop = 0; });
    await page.screenshot({ path: `${out}/scout-video.png` });
    await page.keyboard.press("Escape");
    const summary = page.locator(".ar-summary"), identity = page.locator(".ar-identity");
    expect((await summary.boundingBox()).y).toBeGreaterThan((await identity.boundingBox()).y);
    await expect(summary.getByRole("button", { name: "Остановить всех", exact: true })).toBeVisible();
    await expect(page.locator(".tp-reel-ag.done")).toHaveCount(0);
    await expect(page.locator(".tp-reel-status").first()).toBeVisible();
    await page.screenshot({ path: `${out}/task-status.png` });
    await page.locator(".ar-identity").getByRole("button", { name: "8 агентов", exact: true }).click();
    await page.evaluate(async () => Promise.all(document.getAnimations().filter((a) => a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
    await page.locator(".tp-reel").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/compact-reels.png` });
    await page.getByRole("button", { name: "Разведка", exact: true }).click();
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(modal).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${out}/scout-${width}.png` });
    }
    await expect(modal.getByRole("status")).toHaveCount(0);
    await modal.locator(".ag-ov-item").nth(1).click();
    await expect(modal.locator(".ag-tl-main")).toBeVisible();
    expect(await modal.locator(".ag-ov-pane").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: `${out}/scout-video-390.png` });
    expect(errors).toEqual([]);
    console.log("PASS: isolated status, bounded scout requests, both scroll panes, folds, timeline, responsive layout", { maxStatsInFlight, contextRequests });
  }
} catch (e) { console.log("page", errors, (await page.locator("body").innerText()).slice(0, 2500)); throw e; }
finally { releaseStats(); releaseContext(); releaseRuns(); await browser.close(); }
