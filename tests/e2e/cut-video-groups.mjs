// Реальная страница таски и редактор; API изолирован и не меняет данные сервера.
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const base = process.env.BASE || "http://127.0.0.1:5181";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [], imageRequests = [], unknown = new Set();
page.on("pageerror", (e) => errors.push(e.stack || e.message));
const created = "2026-11-10T09:00:00Z", code = "CUTVIDEOGROUPSCHECK01", taskId = "cut-task";
const project = { id: "project", code, name: "Искра", status: "ready", created_at: created };
const tags = [{ id: "near", name: "Ближняя камера" }, { id: "station", name: "Станция" }];
const v1 = "11111111-1111-4111-8111-111111111111", v2 = "22222222-2222-4222-8222-222222222222", v3 = "33333333-3333-4333-8333-333333333333";
const video = (id, name, frames, tag) => ({ id, file_name: name, mode: "cut", frames, fresh: frames, accepted: 0, tracks: 0,
  tag_ids: [tag], segments: frames ? [{ start_ms: 0, end_ms: 60000, step_ms: 5000 }] : [],
  width: 1920, height: 1080, size_bytes: 155_400_000, duration_ms: 120000, frame_count: 3000, fps: 25,
  prepare: { ready: true, busy: false, error: null }, created_at: created });
const seedVideos = () => [video(v1, "camera_close_2026-10-24_14-00-35.mp4", 31, "near"),
  video(v2, "camera_side_2026-10-25_10-33-45.mp4", 4, "station"), video(v3, "camera_close_2026-10-31_17-41-21.mp4", 0, "near")];
let videos = seedVideos(), failImages = false, empty = false, noVideos = false, readOnly = false;
const seedImages = () => [
  ...Array.from({ length: 31 }, (_, i) => ({ id: `a-${i}`, file_name: `close-frame-${String(i).padStart(3, "0")}.jpg`, source_video_id: v1,
    source_time_ms: i * 5000, task_status: i < 25 ? "new" : i === 30 ? "empty" : "annotated", tag_ids: ["near"],
    boxes: i === 25 ? [{ id: "pending", kind: "bbox", x: 1, y: 1, w: 10, h: 10, class_index: 0, source: "model", pending: true }] : [],
    width: 1920, height: 1080, size_bytes: 100000, annotations: i === 25 ? 1 : 0, accepted: false, rev: 0 })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `b-${i}`, file_name: `side-frame-${i}.jpg`, source_video_id: v2,
    source_time_ms: i * 5000, task_status: i === 3 ? "empty" : "annotated", tag_ids: ["station"], boxes: [],
    width: 1920, height: 1080, size_bytes: 100000, annotations: 0, accepted: false, rev: 0 })),
];
let images = seedImages(), runVideos = null, started = null;
const runClasses = [{ id: "cls", class_index: 0, name: "Человек", color: "#e5484d" }];
const runAgents = [{ id: "agent", name: "Искра · проверка списка", head: "version", group: "project", mine: true, owner: "Соя Иван",
  verdict: { state: "fits", want_mb: 1024, card: "test", reason: "Влезает" },
  versions: [{ id: "version", version: 2, created_at: created, classes: [{ id: "cls", name: "Человек", lock: "cls" }] }] }];
const reviewed = (i) => ["annotated", "empty"].includes(i.task_status) && !i.boxes.some((b) => b.pending);
const countOf = (list) => ({ total: list.length, new: list.filter((i) => i.task_status === "new").length,
  annotated: list.filter((i) => i.task_status === "annotated").length, empty: list.filter((i) => i.task_status === "empty").length,
  skipped: 0, deleted: 0, accepted: 0, reviewed: list.filter(reviewed).length, agent: list.filter((i) => i.boxes.some((b) => b.pending)).length });
const task = () => ({ id: taskId, name: "Первый набор от настоящих камер", status: "in_progress", status_label: "В работе", project,
  is_admin: !readOnly, rights: { edit: !readOnly, fill: !readOnly, tag_frames: !readOnly, assign: !readOnly, moves: [] },
  assignees: [{ id: "me", display_name: "Соя Иван" }], target_dataset: { id: null, name: "Искра: кадры" },
  created_at: created, status_at: created, created_by: "Соя Иван", tags, videos: noVideos ? [] : videos,
  sources: noVideos || empty ? {} : Object.fromEntries(videos.filter((v) => v.frames).map((v) => [v.id, { total: v.frames, frames: v.frames, first_at: created }])),
});
const out = new URL("./test-results/cut-video-groups/", import.meta.url);
const picture = process.env.CUT_FRAME_PICTURE ? await readFile(process.env.CUT_FRAME_PICTURE) : Buffer.from(await page.evaluate(() => {
  const canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 1080;
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#344e41"; ctx.fillRect(0, 0, 1920, 1080);
  ctx.fillStyle = "#ccd5ae"; ctx.fillRect(0, 500, 1920, 80);
  return canvas.toDataURL("image/jpeg").split(",")[1];
}), "base64");
const settle = () => page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all(document.getAnimations().filter((a) => a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
});
try {
  await mkdir(out, { recursive: true });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (/\/(thumb|file|preview|strip)$/.test(path)) return route.fulfill({ contentType: "image/jpeg", body: picture });
    let data;
    const all = noVideos || empty ? [] : images;
    if (path === "/api/auth/me") data = { user: { id: "me", display_name: "Соя Иван", login: "check", hardware: null }, projects: [{ ...project, role: readOnly ? "viewer" : "admin", role_label: readOnly ? "Наблюдатель" : "Администратор" }] };
    else if (path === `/api/projects/${code}`) data = { project, my_role: readOnly ? "viewer" : "admin", members: [], datasets: [], classes: [],
      stats: { images: 0, annotations: 0, size_bytes: 0, datasets: 0, classes: 0, tasks: 1 } };
    else if (path === `/api/tasks/${taskId}`) data = task();
    else if (path === `/api/tasks/${taskId}/counts`) data = { counts: countOf(all), from_files: 0,
      by_source: Object.fromEntries(videos.map((v) => [v.id, countOf(all.filter((i) => i.source_video_id === v.id))])), classes: [] };
    else if (path === `/api/tasks/${taskId}/images`) {
      imageRequests.push(Object.fromEntries(url.searchParams));
      if (failImages) return route.fulfill({ status: 503, json: { error: "Проверка ошибки загрузки" } });
      let list = all;
      if (url.searchParams.get("image")) list = list.filter((i) => i.id === url.searchParams.get("image"));
      const source = url.searchParams.get("source");
      if (source && source !== "videos") list = list.filter((i) => i.source_video_id === source);
      const wanted = url.searchParams.get("tags")?.split(",");
      if (wanted) list = list.filter((i) => i.tag_ids.some((id) => wanted.includes(id)));
      const review = url.searchParams.get("review");
      if (review) list = list.filter((i) => i.task_status !== "deleted");
      const done = list.filter(reviewed).length, review_counts = { new: list.length - done, done };
      if (review && review !== "all") list = list.filter((i) => reviewed(i) === (review === "done"));
      const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 60);
      data = { matched: list.length, review_counts, counts: countOf(all), images: list.slice(offset, offset + limit) };
    }
    else if (path === `/api/tasks/${taskId}/events`) data = { events: [] };
    else if (path === `/api/tasks/${taskId}/questions`) data = { questions: [], can_ask: !readOnly };
    else if (path === `/api/agents/tasks/${taskId}`) data = { agents: runVideos ? runAgents : [], classes: runClasses, mappings: {}, sources: {}, runs: [], videos: runVideos ?? [], tags, can_run: !readOnly, resources: { cards: [], queued: 0 } };
    else if (path === `/api/agents/tasks/${taskId}/runs` && request.method() === "POST") {
      started = request.postDataJSON();
      data = { id: "test-run", status: "stopped", processed: 0, total: 0, stats: {}, agent: "Искра", version: 2,
        sources: [], videos: started.videos, mode: started.mode, rate: null, error: null, queue_reason: null, created_at: created, finished_at: created };
    }
    else if (path === `/api/agents/tasks/${taskId}/runs`) data = { runs: [] };
    else if (path === `/api/agents/tasks/${taskId}/scouts`) data = { scouts: {} };
    else if (path === `/api/projects/${code}/tags`) data = { tags };
    else if (path === `/api/projects/${code}/classes`) data = { classes: [] };
    else if (path.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: ": test\n\n" });
    else if (path.endsWith("/live")) data = { runs: [] };
    else if (path === "/api/gpu") data = { staff: false, manage: false, level: null, cards: [], devices: [], cpu: { slots: 1, busy: 0, holders: [] },
      queue: { mine: [], ahead: 0, total: 0, queue: [] }, live: { used: 0, soft: 1, hard: 1, peak: 0 }, settings: {} };
    else if (path === "/api/auto/sessions") data = { sessions: [] };
    else if (path === "/api/tasks/questions-inbox") data = { items: [], total: 0 };
    else if (path === "/api/friends") data = { friends: [], incoming: [], outgoing: [] };
    else if (path === "/api/invitations") data = { invitations: [] };
    else if (path === "/api/projects") data = { projects: [] };
    else { unknown.add(path); return route.fulfill({ status: 404, json: { error: "Unavailable in cut-gallery check" } }); }
    return route.fulfill({ json: data });
  });
  const goto = () => page.goto(`${base}/projects/${code}/tasks/${taskId}`);
  await goto();
  const gallery = page.locator("#task-cut-frames");
  await expect(gallery).toContainText("9 размечено");
  await expect(gallery).toContainText("26 не размечено");
  await expect(page.locator(".tp-main > section").first()).toHaveAttribute("id", "task-cut-frames");
  await expect(gallery.getByRole("button", { name: "Показать", exact: true })).toHaveAttribute("aria-expanded", "false");
  expect(imageRequests).toHaveLength(0);
  await settle(); await page.screenshot({ path: fileURLToPath(new URL("app-overview.png", out)) });
  await page.getByRole("button", { name: /Смотреть кадры/ }).click();
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(35);
  await expect(gallery.getByRole("region", { name: "Размечены", exact: true })).toBeVisible();
  await expect(gallery.getByRole("navigation", { name: "Страницы" })).toHaveCount(0);
  await expect(gallery.locator(".tp-cut-model")).toHaveCount(1);
  const state = await gallery.locator(".tp-cut-toolbar > .ui-seg").boundingBox(), filter = await gallery.locator(".tp-cut-filters").boundingBox();
  expect(Math.abs(state.y + state.height / 2 - filter.y - filter.height / 2)).toBeLessThan(2);
  await settle(); await page.screenshot({ path: fileURLToPath(new URL("app-gallery.png", out)) });
  await gallery.getByRole("button", { name: "Список", exact: true }).click();
  await expect(gallery.locator(".as-list .tp-cut-tile")).toHaveCount(35);
  await gallery.getByRole("combobox", { name: "Фильтр по ролику" }).click();
  await page.getByRole("option", { name: videos[1].file_name, exact: true }).click();
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(4);
  await gallery.getByRole("button", { name: "Скрыть", exact: true }).click();
  await expect(gallery).toContainText("35");
  await gallery.getByRole("button", { name: "Показать", exact: true }).click();
  await expect(gallery.locator(".as-list .tp-cut-tile")).toHaveCount(4);
  await gallery.getByRole("button", { name: /^Не размечены/ }).click();
  await expect(gallery).toContainText("Не размечены: кадров нет");
  await gallery.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(35);
  await gallery.getByRole("button", { name: "Фильтр по тагам" }).click();
  await page.getByRole("checkbox", { name: "Станция", exact: true }).check();
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(4);
  await gallery.getByRole("button", { name: "Сбросить", exact: true }).click();
  const cut = page.locator(".tp-cut-group").filter({ hasText: /^Нарезанные/ });
  const uncut = page.locator(".tp-cut-group").filter({ hasText: /^Ненарезанные/ });
  await expect(cut.locator(".tp-reel")).toHaveCount(2); await expect(uncut.locator(".tp-reel")).toHaveCount(1);
  await cut.getByRole("searchbox").fill("side");
  await expect(cut.locator(".tp-reel")).toHaveCount(1); await expect(uncut.locator(".tp-reel")).toHaveCount(1);
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(35);
  await cut.getByRole("button", { name: "Сбросить", exact: true }).click();
  await cut.locator(".tp-reel").first().getByRole("button", { name: /^31 кадр/ }).click();
  await expect(cut.locator(".tp-reel-frames .tp-cut-tile")).toHaveCount(31);
  expect(imageRequests.some((r) => r.source === v1 && r.review === "all" && r.limit === "50")).toBe(true);
  await cut.locator(".ui-card-a").getByRole("button", { name: "Скрыть", exact: true }).click();
  await expect(cut.locator(".tp-source-fold").first()).toHaveAttribute("inert", "");
  await cut.locator(".ui-card-a").getByRole("button", { name: "Показать", exact: true }).click();
  await expect(cut.locator(".tp-reel-frames.open")).toHaveCount(1);
  await gallery.getByRole("button", { name: "Плитка", exact: true }).click();
  await gallery.locator(".tp-cut-tile").first().click();
  await expect(page.getByRole("dialog", { name: "Разметка кадров", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/frame=a-0/);
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/frame=a-1/);
  await page.getByRole("button", { name: "К таске (Esc)", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Разметка кадров", exact: true })).toHaveCount(0);

  await gallery.getByRole("button", { name: "Скрыть", exact: true }).click();
  failImages = true;
  await gallery.getByRole("button", { name: "Показать", exact: true }).click();
  await expect(gallery.getByText("Проверка ошибки загрузки").first()).toBeVisible();
  failImages = false;
  await gallery.getByRole("button", { name: "Повторить", exact: true }).first().click();
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(35);

  // Тысяча роликов не создаёт тысячу превью; страницы кадров заменяют друг друга.
  videos = [video(v1, "bulk-0000.mp4", 107, "near"),
    ...Array.from({ length: 999 }, (_, i) => video(`bulk-${i + 1}`, `bulk-${String(i + 1).padStart(4, "0")}.mp4`, 1, "near")),
    ...Array.from({ length: 51 }, (_, i) => video(`uncut-${i}`, `uncut-${i}.mp4`, 0, "station"))];
  const template = seedImages()[0];
  images = videos.flatMap((v) => Array.from({ length: v.frames }, (_, i) => ({ ...template,
    id: `${v.id}-${i}`, file_name: `${v.file_name}-${i}.jpg`, source_video_id: v.id,
    task_status: i % 2 ? "annotated" : "new", tag_ids: v.tag_ids })));
  await page.reload();
  await expect(cut.locator(".tp-reel")).toHaveCount(50);
  await expect(uncut.locator(".tp-reel")).toHaveCount(50);
  await expect(cut.getByRole("button", { name: "20", exact: true })).toBeVisible();
  await cut.getByRole("button", { name: /Дальше/ }).click();
  await expect(cut.locator(".tp-reel").first()).toContainText("bulk-0050.mp4");
  await expect(cut.locator(".tp-reel")).toHaveCount(50);
  await cut.getByRole("searchbox").fill("bulk-0999");
  await expect(cut.locator(".tp-reel")).toHaveCount(1);
  await expect(cut.locator(".tp-reel").first()).toContainText("bulk-0999.mp4");
  await cut.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(cut.locator(".tp-reel").first()).toContainText("bulk-0000.mp4");
  await uncut.getByRole("button", { name: /Дальше/ }).click();
  await expect(uncut.locator(".tp-reel")).toHaveCount(1);
  await expect(cut.locator(".tp-reel")).toHaveCount(50);
  await page.getByRole("button", { name: /Смотреть кадры/ }).click();
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(50);
  const pagingRequest = imageRequests.length;
  await gallery.getByRole("button", { name: /Дальше/ }).click();
  await expect(gallery).toContainText("Кадры 51–100");
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(50);
  expect(imageRequests.slice(pagingRequest).some((r) => r.limit === "50" && r.offset === "50")).toBe(true);
  await gallery.getByRole("button", { name: /^Размечены/ }).click();
  await expect(gallery).toContainText("Кадры 1–50 из 53");
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(50);
  await gallery.getByRole("button", { name: /Дальше/ }).click();
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(3);
  await gallery.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(gallery).toContainText("Кадры 1–50");
  await gallery.getByRole("combobox", { name: "Фильтр по ролику" }).click();
  await page.getByRole("option", { name: "bulk-0000.mp4", exact: true }).click();
  await expect(gallery).toContainText("Кадры 1–50 из 107");
  await gallery.getByRole("button", { name: "3", exact: true }).click();
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(7);
  await gallery.getByRole("button", { name: /Назад/ }).click();
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(50);
  await expect(gallery).toContainText("Кадры 51–100 из 107");
  await gallery.getByRole("button", { name: "Скрыть", exact: true }).click();
  await gallery.getByRole("button", { name: "Показать", exact: true }).click();
  await expect(gallery).toContainText("Кадры 51–100 из 107");
  await cut.locator(".tp-reel").first().getByRole("button", { name: /^107 кадров/ }).click();
  const reelGallery = cut.locator(".tp-reel-frames.open");
  await expect(reelGallery.locator(".tp-cut-tile")).toHaveCount(50);
  await reelGallery.getByRole("button", { name: "3", exact: true }).click();
  await expect(reelGallery.locator(".tp-cut-tile")).toHaveCount(7);
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(50);
  await gallery.getByRole("button", { name: "3", exact: true }).click();
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(7);
  images = images.filter((image) => image.source_video_id !== v1 || Number(image.id.split("-").at(-1)) < 60);
  await gallery.getByRole("button", { name: "Скрыть", exact: true }).click();
  await gallery.getByRole("button", { name: "Показать", exact: true }).click();
  await expect(gallery).toContainText("Кадры 51–60 из 60");
  await expect(gallery.locator(".tp-cut-tile")).toHaveCount(10);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await gallery.evaluate((n) => n.scrollIntoView({ block: "end", behavior: "instant" }));
  await page.screenshot({ path: fileURLToPath(new URL("app-pagination-390.png", out)) });
  await page.setViewportSize({ width: 1440, height: 960 });

  // Окно запуска: тысяча роликов не закрывает параметры прогона длинным списком.
  runVideos = Array.from({ length: 1001 }, (_, i) => ({ id: `run-${i}`, file_name: `camera_${String(i).padStart(4, "0")}.mp4`,
    mode: i < 1000 ? "cut" : "annotate", frames: 15000, tag_ids: [i % 2 ? "station" : "near"] }));
  runVideos[0].file_name = "camera_close_2026-10-24_18-10-15_recovered.mp4";
  await page.reload();
  await expect(cut.locator(".tp-reel")).toHaveCount(50);
  await page.keyboard.press("g");
  await page.getByRole("dialog", { name: "Агент таски", exact: true }).getByRole("button", { name: "Разметить агентом…", exact: true }).click();
  const runDialog = page.getByRole("dialog", { name: "Разметить агентом", exact: true });
  await runDialog.getByRole("radio", { name: /^Разведка/ }).check();
  const picker = runDialog.getByRole("region", { name: "Выбор роликов" });
  const runRows = picker.getByRole("group", { name: "Ролики", exact: true }).locator(".ui-check-l");
  await expect(runRows).toHaveCount(5);
  const search = picker.getByRole("searchbox", { name: "Поиск роликов" });
  await search.fill("CAMERA_0999");
  await expect(runRows).toHaveCount(1);
  await runRows.getByRole("checkbox").check();
  await search.fill("");
  await picker.getByRole("button", { name: "Фильтр по тагам" }).click();
  await page.getByRole("checkbox", { name: "Станция", exact: true }).check();
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await picker.getByRole("checkbox", { name: /Выбрать найденные/ }).check();
  await expect(picker.getByRole("status")).toContainText("Выбрано 500 из 1 001");
  await picker.getByRole("button", { name: "Раскрыть список", exact: true }).click();
  await expect(runRows).toHaveCount(20);
  expect(await picker.locator(".ar-video-list").evaluate((n) => n.clientHeight)).toBeLessThanOrEqual(240);
  await settle();
  await page.screenshot({ path: fileURLToPath(new URL("agent-picker-expanded.png", out)) });
  await picker.getByRole("button", { name: "25", exact: true }).click();
  await expect(runRows.last()).toContainText("camera_0999.mp4");
  await search.fill("camera_0999");
  await expect(runRows).toHaveCount(1);
  await search.fill("не существует");
  await expect(runRows).toHaveCount(0);
  await expect(picker).toContainText("Ролики не найдены");
  await expect(picker.getByRole("status")).toContainText("вне фильтра: 500");
  await picker.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(runRows.first()).toContainText(runVideos[0].file_name);
  await expect(runRows).toHaveCount(20);
  await picker.getByRole("button", { name: "Свернуть список", exact: true }).click();
  await expect(runRows).toHaveCount(5);
  for (const width of [909, 390]) {
    await page.setViewportSize({ width, height: width === 909 ? 718 : 844 });
    await settle();
    expect(await runDialog.evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
    await page.screenshot({ path: fileURLToPath(new URL(`agent-picker-${width}.png`, out)) });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  // Фильтр скрывает выбранное, но запуск получает весь явно выбранный набор.
  await search.fill("camera_1000");
  await expect(picker.getByRole("status")).toContainText("вне фильтра: 500");
  await runDialog.getByRole("button", { name: "Разведать 500 роликов", exact: true }).click();
  await expect(runDialog).toHaveCount(0);
  expect(started.mode).toBe("scout");
  expect(started.videos).toEqual(runVideos.filter((v) => v.tag_ids.includes("station")).map((v) => v.id));
  await page.keyboard.press("g");
  await page.getByRole("dialog", { name: "Агент таски", exact: true }).getByRole("button", { name: "Разметить агентом…", exact: true }).click();
  await runDialog.getByRole("radio", { name: /^Разметка ролика/ }).check();
  await expect(runRows).toHaveCount(1);
  await expect(runRows.first()).toContainText("camera_1000.mp4");
  await picker.getByRole("checkbox", { name: /Выбрать все/ }).check();
  await expect(picker.getByRole("status")).toContainText("Выбрано 1 из 1");
  await picker.getByRole("button", { name: "Снять выбор", exact: true }).click();
  await expect(runDialog.getByRole("button", { name: "Разметить до 0 кадров", exact: true })).toBeDisabled();
  await runDialog.getByRole("button", { name: "Отмена", exact: true }).click();
  // Запуск из группы сохраняет исходные 1000 выбранных, но не берёт 51 ролик другой группы.
  runVideos = videos.map((v) => ({ ...v, frames: 15000 }));
  await cut.getByRole("button", { name: "Агент", exact: true }).click();
  await runDialog.getByRole("radio", { name: /^Разведка/ }).check();
  await expect(runRows).toHaveCount(5);
  await expect(picker.getByRole("status")).toContainText("Выбрано 1 000 из 1 000");
  await runDialog.getByRole("button", { name: "Отмена", exact: true }).click();
  runVideos = null;

  empty = true; videos = seedVideos().map((v) => ({ ...v, frames: 0, segments: [] }));
  await page.reload();
  await expect(gallery).toContainText("Нарезанных кадров пока нет");
  await expect(page.locator(".tp-cut-group")).toHaveCount(1);
  await page.getByRole("button", { name: /Смотреть кадры/ }).click();
  await expect(gallery).toContainText("Кадры появятся после нарезки");
  noVideos = true; await page.reload();
  await expect(page.locator(".page.tp")).toBeVisible();
  await expect(gallery).toHaveCount(0);
  empty = noVideos = false; readOnly = true; videos = seedVideos(); images = seedImages();
  for (const width of [1366, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await goto();
    await expect(gallery.getByRole("button", { name: "Показать", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Смотреть кадры/ }).click();
    await expect(gallery.locator(".tp-cut-tile")).toHaveCount(35);
    await settle();
    await gallery.evaluate((n) => n.scrollIntoView({ block: "start", behavior: "instant" }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await gallery.evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
    await page.screenshot({ path: fileURLToPath(new URL(`app-gallery-${width}.png`, out)) });
    await page.goto(base + "/projects");
  }
  expect(errors).toEqual([]);
  console.log("PASS: TaskPage/gallery, agent picker 1001 videos, collapse/paging/search/tags, bulk/hidden selection and launch payload, annotate mode, initial group scope, responsive layout, editor/navigation, retry and empty/read-only states");
  if (unknown.size) console.log("Other stubbed endpoints:", [...unknown]);
} catch (e) {
  console.error("Page errors:", errors, "Other endpoints:", [...unknown]);
  console.error("Task cache:", await page.evaluate(() => localStorage.getItem("mag.cache.me:task:cut-task")));
  await page.screenshot({ path: fileURLToPath(new URL("app-failure.png", out)), fullPage: true }); throw e;
} finally { await browser.close(); }
