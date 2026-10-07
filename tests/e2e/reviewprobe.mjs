/** Проба: проверка разметки агента и разведка-призраки глазами браузера.
 *  Временный проект tester: кадры с рамками агента на проверке, ролик с непроверенным
 *  и разведкой, ролик на нарезку с разведкой. Рамки и находки кладутся в базу напрямую
 *  (агент не нужен). В конце проект удаляется.
 *  BASE — через проброс на localhost (forward.mjs): WebCodecs живёт только в защищённом контексте. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch(existsSync("/opt/google/chrome/chrome") ? { channel: "chrome" } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/401|404/.test(m.text()) && errors.push(m.text()));

/** SQL в базу стенда — тем же psycopg2, что у API-тестов. */
const sql = (query, params = []) => execFileSync("python3", ["-c", `
import json, os, sys, psycopg2
c = psycopg2.connect(os.environ.get("TEST_DB_DSN", "postgresql://app:app@db:5432/app")); c.autocommit = True
cur = c.cursor(); cur.execute(sys.argv[1], json.loads(sys.argv[2]))
`, query, JSON.stringify(params)]);

await page.goto(BASE + "/");
console.log("вход:", await page.evaluate(async () => (await fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
})).status));

const api = async (method, url, data) => {
  const r = await page.request.fetch(BASE + url, { method, data });
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? null : r.json();
};
const jpeg = (hue) => page.evaluate(async (h) => {
  const c = document.createElement("canvas");
  c.width = 960; c.height = 600;
  const g = c.getContext("2d");
  g.fillStyle = `hsl(${h} 25% 30%)`; g.fillRect(0, 0, 960, 600);
  g.fillStyle = `hsl(${h} 30% 55%)`; g.fillRect(120, 180, 300, 200); g.fillRect(560, 240, 220, 160);
  const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  return [...new Uint8Array(await b.arrayBuffer())];
}, hue);

let temp = null;
try {
  const proj = await api("POST", "/api/projects", { name: `test-review-${Date.now() % 100000}` });
  temp = proj.code;
  const wagon = await api("POST", `/api/projects/${temp}/classes`, { name: "вагон" });
  const man = await api("POST", `/api/projects/${temp}/classes`, { name: "человек" });
  const task = await api("POST", `/api/projects/${temp}/tasks`, { name: "Проба проверки агента" });
  await api("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
  for (const [i, h] of [[1, 210], [2, 30], [3, 140]].entries()) {
    await page.request.post(`${BASE}/api/tasks/${task.id}/images`, {
      multipart: { files: { name: `kadr-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(await jpeg(h[1])) } },
    });
  }
  const imgs = (await api("GET", `/api/tasks/${task.id}/images`)).images;
  const ann = (img, cls, x, y, w, h, conf) => sql(
    `INSERT INTO annotations (id, image_id, class_id, ann_type, geometry, area, iscrowd, source, pending, attributes, created_at)
     VALUES (gen_random_uuid(), %s, %s, 'bbox', %s, %s, false, 'model', true, %s, now())`,
    [img, cls, JSON.stringify({ x, y, w, h }), w * h, JSON.stringify({ conf })]);
  ann(imgs[0].id, wagon.id, 120, 180, 300, 200, 0.93);
  ann(imgs[0].id, man.id, 560, 240, 220, 160, 0.61);
  ann(imgs[2].id, wagon.id, 118, 176, 304, 206, 0.88);

  // Ролик на разметку: непроверенное агента на трёх кадрах и разведка
  const up = await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
    multipart: { file: { name: "perehod.mp4", mimeType: "video/mp4", buffer: readFileSync("/tmp/magistral-sample-300f.mp4") },
      mode: "annotate" },
  });
  const video = await up.json();
  const single = (f, cls, x, conf) => sql(
    `INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source, pending, attributes, created_at)
     VALUES (gen_random_uuid(), %s, %s, %s, 'bbox', %s, 'model', true, %s, now())`,
    [video.id, f, cls, JSON.stringify({ x, y: 90, w: 70, h: 60 }), JSON.stringify({ conf })]);
  single(50, wagon.id, 40, 0.9); single(50, man.id, 180, 0.58); single(125, wagon.id, 90, 0.82); single(225, man.id, 150, 0.71);
  const frames = {};
  for (let f = 0; f < 300; f += 25) {
    frames[f] = f >= 75 && f <= 175 ? [["локомотив", 0.8, 60 + f / 5, 70, 90, 70], ["путеец", 0.66, 220, 120, 30, 70]]
      : f >= 200 ? [["путеец", 0.74, 200, 110, 34, 76]] : [];
  }
  const segments = { "локомотив": [[63, 187, 5]], "путеец": [[63, 187, 5], [188, 299, 4]] };
  const scout = (vid) => sql(
    `INSERT INTO video_scouts (id, video_id, agent_name, step, gap_s, last_frame, frames, segments, created_at)
     VALUES (gen_random_uuid(), %s, 'Путеец', 25, 2, 299, %s, %s, now())`,
    [vid, JSON.stringify(frames), JSON.stringify(segments)]);
  scout(video.id);
  const cutUp = await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
    multipart: { file: { name: "narezka.mp4", mimeType: "video/mp4", buffer: readFileSync("/tmp/magistral-sample-300f.mp4") },
      mode: "cut" },
  });
  scout((await cutUp.json()).id);

  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}`);
  await page.getByRole("button", { name: /Проверить/ }).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/rv-task.png`, fullPage: true });
  // Меню «⋯» ролика на разметку: агент таски, режимы, шаг, удаление
  await page.locator(".tp-vid", { hasText: "perehod.mp4" }).getByRole("button", { name: /Ещё: perehod/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/rv-menu.png` });
  await page.keyboard.press("Escape");
  await page.locator(".tp-src", { hasText: "Ролики на нарезку" }).getByRole("button", { name: "Агент: ролики на нарезку" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/rv-menu-cut.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  // Кнопка «Агент» блока роликов на разметку: в разведке — только ролики этого блока
  await page.locator(".tp-src", { hasText: "Ролики на разметку" }).getByRole("button", { name: "Агент", exact: true }).click();
  await page.locator(".ar").waitFor({ timeout: 20000 });
  await page.getByRole("radio", { name: /Разведка/ }).click().catch(() => page.getByText("Разведка", { exact: true }).last().click());
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/rv-block-scout.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.locator(".ui-ph-a").getByRole("button", { name: /Агент/ }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/rv-setup.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // «Фокус» на кадрах блока, ждущих проверки
  await page.locator(".tp-src", { hasText: "Изображения" }).getByRole("button", { name: /Проверить/ }).click();
  const fe = page.getByRole("dialog", { name: "Разметка кадров" });
  await fe.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/rv-focus.png` });
  await fe.locator(".fe-side").screenshot({ path: `${OUT}/rv-focus-side.png` });
  await fe.locator(".ed-tool-more").nth(2).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/rv-agent-pop.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/rv-focus-next.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // Ролик: дорожка «Агент», плашка проверки, призраки разведки
  await page.reload();
  const open = page.locator(".tp-vid", { hasText: "perehod.mp4" }).getByRole("button", { name: /Проверить/ });
  await open.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => ![...document.querySelectorAll(".tp-vid button")].some((b) => b.textContent?.includes("Проверить") && b.disabled), null, { timeout: 90000 }).catch(() => {});
  await open.click();
  const ed = page.getByRole("dialog", { name: "Разметка видео" });
  await ed.waitFor({ timeout: 20000 });
  await ed.locator(".ve-busy").waitFor({ state: "detached", timeout: 30000 }).catch(() => console.log("кадр не показался"));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/rv-video.png` });
  // Курсор рядом с риской агента — она растёт
  const tick = ed.locator(".ve-t.agent").nth(1);
  const tb = await tick.boundingBox();
  if (tb) {
    await page.mouse.move(tb.x + tb.width / 2 + 6, tb.y + tb.height / 2);
    await page.waitForTimeout(300);
    await ed.locator(".ve-dock").screenshot({ path: `${OUT}/rv-lanes.png` });
  }
  if (!(await ed.locator(".mag-cv-ghost").count())) await page.keyboard.press("r");
  await page.keyboard.press("]");
  await page.waitForTimeout(400);
  await page.keyboard.press("]");
  await ed.locator(".ve-busy").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/rv-video-scout.png` });
  const ghost = ed.locator(".mag-cv-ghost").first();
  if (await ghost.count()) {
    const gb = await ghost.boundingBox();
    // Плашка проверки на кадре главнее разведки — подтверждаем кадр, затем выбираем находку
    if (await ed.locator(".ed-review:not(.scout)").count()) { await page.keyboard.press("Enter"); await page.waitForTimeout(1500); }
    await page.mouse.click(gb.x + 3, gb.y + gb.height / 2);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/rv-ghost.png` });
  }
  await ed.locator(".ve-dock").screenshot({ path: `${OUT}/rv-dock-scout.png` });
  // Кадр без непроверенного: только находки — плашка разведки, щелчок по призраку
  const scoutDot = ed.locator(".ve-tl > .ve-r .ve-t.dot").nth(1);
  const db0 = await scoutDot.boundingBox().catch(() => null);
  if (db0) {
    await page.mouse.click(db0.x + db0.width / 2 + 4, db0.y + db0.height / 2);
    await ed.locator(".ve-busy").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const g = ed.locator(".mag-cv-ghost").first();
    const gb2 = await g.boundingBox().catch(() => null);
    if (gb2) { await page.mouse.click(gb2.x + 2, gb2.y + gb2.height / 2); await page.waitForTimeout(400); }
    await page.screenshot({ path: `${OUT}/rv-scoutbar.png` });
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // Нарезка: полоса разведки с точками, щелчок — призраки поверх плеера
  await page.locator(".tp-reel", { hasText: "narezka.mp4" }).getByRole("button", { name: /Нарезать|Смотреть/ }).click();
  await page.locator(".vc").waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const dot = page.locator(".ag-band-dots i").nth(4);
  if (await dot.count()) {
    const db = await dot.boundingBox();
    await page.mouse.move(db.x + db.width / 2 + 5, db.y + db.height / 2);
    await page.waitForTimeout(200);
    await page.mouse.click(db.x + db.width / 2 + 5, db.y + db.height / 2);
    await page.waitForTimeout(1800);
  }
  await page.screenshot({ path: `${OUT}/rv-cut.png` });
} finally {
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
