/** Проба: призраки разведки поверх плеера нарезки должны лечь ровно на объекты.
 *  Ролик H.264 1280×720 с двумя прямоугольниками в известных местах; разведка кладётся
 *  в базу рамками ровно по ним. Снимок кадра и размеры плеера/слоя. Проект удаляется. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://localhost:8097";
const OUT = "/work/tests/e2e/test-results";
const CLIP = process.env.CLIP || "/tmp/review-h264.mp4";
const browser = await chromium.launch(existsSync("/opt/google/chrome/chrome") ? { channel: "chrome" } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const sql = (query, params = []) => execFileSync("python3", ["-c", `
import json, os, sys, psycopg2
c = psycopg2.connect(os.environ.get("TEST_DB_DSN", "postgresql://app:app@db:5432/app")); c.autocommit = True
c.cursor().execute(sys.argv[1], json.loads(sys.argv[2]))
`, query, JSON.stringify(params)]);

await page.goto(BASE + "/");
await page.evaluate(() => fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
}));
const api = async (method, url, data) => {
  const r = await page.request.fetch(BASE + url, { method, data });
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${await r.text()}`);
  return r.json();
};

let temp = null;
try {
  temp = (await api("POST", "/api/projects", { name: `test-cutscout-${Date.now() % 100000}` })).code;
  const task = await api("POST", `/api/projects/${temp}/tasks`, { name: "Проба разведки в нарезке" });
  await api("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
  const up = await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
    multipart: { file: { name: "h264.mp4", mimeType: "video/mp4", buffer: readFileSync(CLIP) }, mode: "cut" },
  });
  const video = await up.json();
  const frames = {};
  for (let f = 0; f < 300; f += 25) frames[f] = [["оранжевый", 0.9, 100, 100, 200, 150], ["зелёный", 0.8, 900, 450, 280, 230]];
  sql(`INSERT INTO video_scouts (id, video_id, agent_name, step, gap_s, last_frame, frames, segments, created_at)
       VALUES (gen_random_uuid(), %s, 'проба', 25, 2, 299, %s, %s, now())`,
  [video.id, JSON.stringify(frames), JSON.stringify({ "оранжевый": [[0, 299, 12]], "зелёный": [[0, 299, 12]] })]);

  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}`);
  await page.locator(".tp-reel", { hasText: "h264.mp4" }).getByRole("button", { name: /Нарезать|Смотреть/ }).click();
  await page.locator(".vc").waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);
  const dot = page.locator(".ag-band-dots i").nth(3);
  const b = await dot.boundingBox();
  await page.mouse.click(b.x + b.width / 2 + 3, b.y + b.height / 2);
  await page.waitForTimeout(2000);
  console.log("размеры:", JSON.stringify(await page.evaluate(() => {
    const v = document.querySelector(".vc-stage > video");
    const svg = document.querySelector(".vc-ghosts .mk");
    const r = (el) => el && (({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect());
    const rects = [...document.querySelectorAll(".vc-ghosts .mag-cv-line")].map((p) => r(p));
    return { video: r(v), vw: v?.videoWidth, vh: v?.videoHeight, svg: r(svg), rects };
  })));
  await page.screenshot({ path: `${OUT}/cs-paused.png` });
  console.log("лента:", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".vc canvas")].map((c) => {
    const ctx = c.getContext("2d"); const w = c.width, h = c.height;
    let lit = 0;
    if (w && h) { const d = ctx.getImageData(0, 0, w, h).data; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++; }
    return { cls: c.className, w, h, opacity: c.style.opacity, lit };
  }))));
  console.log("скрытые плееры:", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".vc video")].map((v) => ({
    cls: v.className, rs: v.readyState, vw: v.videoWidth, t: v.currentTime, err: v.error && v.error.code,
  })))));
  // Отдельный кадр (F): у него должно быть превью, а не заглушка «кадр»
  await page.keyboard.press("f");
  await page.waitForTimeout(2500);
  console.log("превью отдельных кадров:", JSON.stringify(await page.evaluate(() =>
    [...document.querySelectorAll(".vc-side img")].map((i) => ({ ok: i.naturalWidth > 0, src: i.src.slice(0, 22) })))));
  await page.locator(".vc-side").screenshot({ path: `${OUT}/cs-singles.png` });
  // Наведение на призрак — он должен стать непрозрачным
  const g = page.locator(".vc-ghosts .mag-cv-hit").first();
  const gb = await g.boundingBox();
  if (gb) { await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2); await page.waitForTimeout(300); }
  await page.screenshot({ path: `${OUT}/cs-hover.png` });
  // Проигрывание: призраки держатся около найденного кадра
  await page.keyboard.press("Space");
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/cs-playing.png` });
  await page.keyboard.press("Space");
  // Сохранённый план: кадры приходят с сервера, превью доснимает скрытый плеер
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("f");
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^Применить/ }).click();
  await page.getByText(/Нарезано|нарезан/).first().waitFor({ timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  await page.locator(".tp-reel", { hasText: "h264.mp4" }).getByRole("button", { name: /Нарезать|Смотреть/ }).click();
  await page.locator(".vc").waitFor({ timeout: 20000 });
  await page.waitForTimeout(5000);
  console.log("превью из плана:", JSON.stringify(await page.evaluate(() => ({
    img: document.querySelectorAll(".vc-side img").length, stub: document.querySelectorAll(".vc-side .vc-noimg").length,
  }))));
  await page.locator(".vc-side").screenshot({ path: `${OUT}/cs-saved.png` });
} finally {
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
