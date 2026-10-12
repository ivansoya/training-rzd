/** Проба: доска, страница таски и редактор ролика грузятся по частям — глазами браузера, со счётом.
 *  Временный проект tester: таска с роликом H.264 и 6000 рамками агента (по 40 на каждый 2-й кадр) —
 *  четыре куска. Ответы со счётчиками и кусками придерживаются, чтобы застать заготовки. В конце проект удаляется.
 *  Запуск в yolo-tests: TEST_BASE_URL=http://frontend:81 node forward.mjs & BASE=http://localhost:8099 node loadprobe.mjs */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://localhost:8099";
const OUT = "/work/tests/e2e/test-results";
const CLIP = "/tmp/load-h264.mp4";
const HOLD = Number(process.env.HOLD || 700);

if (!existsSync(CLIP)) {
  execFileSync("python3", ["-c", `
import av, numpy as np
c = av.open("${CLIP}", "w"); s = c.add_stream("libx264", rate=25); s.width, s.height, s.pix_fmt = 640, 360, "yuv420p"
for i in range(300):
    a = np.zeros((360, 640, 3), np.uint8); a[:, :, 0] = (i * 3) % 255; a[100:200, (i * 2) % 600:(i * 2) % 600 + 40] = 255
    for p in s.encode(av.VideoFrame.from_ndarray(a, format="rgb24")): c.mux(p)
for p in s.encode(): c.mux(p)
c.close()`]);
}

const browser = await chromium.launch(existsSync("/opt/google/chrome/chrome") ? { channel: "chrome" } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/401|404/.test(m.text()) && errors.push(m.text()));
const sql = (query, params = []) => execFileSync("python3", ["-c", `
import json, os, sys, psycopg2
c = psycopg2.connect(os.environ.get("TEST_DB_DSN", "postgresql://app:app@db:5432/app")); c.autocommit = True
cur = c.cursor(); cur.execute(sys.argv[1], json.loads(sys.argv[2]))
`, query, JSON.stringify(params)]);
const check = (name, ok, extra = "") => console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Придержать ответы, чтобы застать заготовки: локальный стенд отвечает быстрее глаза
const hold = (re) => page.route(re, async (route) => { await wait(HOLD); await route.continue(); });

await page.goto(BASE + "/");
// Пароль tester на стендах разный — пробуем оба
for (const password of [process.env.PASS, "VniiTest", "123456"].filter(Boolean)) {
  const ok = await page.evaluate(async (pw) => (await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity: "tester", password: pw }),
  })).ok, password);
  if (ok) break;
}
const api = async (method, url, data) => {
  const r = await page.request.fetch(BASE + url, { method, data });
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? null : r.json();
};

let temp = null;
try {
  const proj = await api("POST", "/api/projects", { name: `test-load-${Date.now() % 100000}` });
  temp = proj.code;
  const car = await api("POST", `/api/projects/${temp}/classes`, { name: "машина" });
  for (const n of ["Вторая", "Третья"]) await api("POST", `/api/projects/${temp}/tasks`, { name: n });
  const task = await api("POST", `/api/projects/${temp}/tasks`, { name: "Ролик агента" });
  await api("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
  const video = await (await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
    multipart: { file: { name: "agent.mp4", mimeType: "video/mp4", buffer: readFileSync(CLIP) }, mode: "annotate" },
  })).json();
  sql(`INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source, pending, attributes, created_at)
       SELECT gen_random_uuid(), %s, f, %s, 'bbox', json_build_object('x', 10 + k * 15, 'y', 40 + (k %% 5) * 50, 'w', 12, 'h', 12),
              'model', true, json_build_object('conf', 0.8), now()
       FROM generate_series(0, 298, 2) f, generate_series(0, 39) k`, [video.id, car.id]);
  // Ролик готовится воркером — ждём готовность перегонов
  for (let i = 0; i < 60; i++) {
    const t = await api("GET", `/api/tasks/${task.id}`);
    if (t.videos[0]?.prepare?.ready) break;
    await wait(1000);
  }

  // --- доска: высота карточек до и после счётчиков ---
  await hold(/\/api\/tasks\/[^/]+\/summary$/);
  await page.goto(`${BASE}/projects/${temp}/tasks`);
  await page.locator(".tb-card").first().waitFor();
  await wait(HOLD / 2);
  const shim = await page.locator(".tb-zone.ui-shim").count();
  const skel = await page.locator(".tb-zone .ui-sk").count();
  const before = await page.$$eval(".tb-card:not(.closed)", (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  await page.screenshot({ path: `${OUT}/load-board-mid.png` });
  check("доска: переливается одна карточка в пути", shim === 1, `с переливом ${shim}, заготовок ${skel}`);
  await page.locator(".ui-upd").waitFor({ state: "detached", timeout: 15000 });
  const after = await page.$$eval(".tb-card:not(.closed)", (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  check("доска: высота карточек не меняется", JSON.stringify(before) === JSON.stringify(after), `${before} → ${after}`);
  check("доска: «ждут закрытия» у ролика", await page.locator(".tb-card", { hasText: "Ролик агента" }).getByText("ждут закрытия").count() === 1);

  // --- доска из кеша: числа сразу ---
  await page.reload();
  await page.locator(".tb-card").first().waitFor();
  const cachedNums = await page.locator(".tb-card", { hasText: "Ролик агента" }).getByText("ждут закрытия").count();
  check("доска из кеша: числа на месте до ответа", cachedNums === 1);
  await page.unroute(/\/api\/tasks\/[^/]+\/summary$/);

  // --- страница таски: паспорт и карточка ролика той же высоты ---
  await hold(/\/api\/tasks\/[^/]+\/(counts|videos\/[^/]+\/pending)$/);
  await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes(":task:")).forEach((k) => localStorage.removeItem(k)));
  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}`);
  await page.locator(".tp-pass").waitFor();
  await wait(HOLD / 3);
  const h = () => page.evaluate(() => [".tp-pass", ".tp-vid"].map((s) => Math.round(document.querySelector(s)?.getBoundingClientRect().height ?? -1)));
  const tpBefore = await h();
  await page.screenshot({ path: `${OUT}/load-task-mid.png` });
  await page.locator(".ui-sk").first().waitFor({ state: "detached", timeout: 15000 });
  await wait(400);
  const tpAfter = await h();
  check("таска: паспорт и ролик той же высоты", JSON.stringify(tpBefore) === JSON.stringify(tpAfter), `${tpBefore} → ${tpAfter}`);
  check("таска: шесть строк состояний", await page.locator(".tp-cnt").count() === 6);
  await page.unroute(/\/api\/tasks\/[^/]+\/(counts|videos\/[^/]+\/pending)$/);

  // --- редактор: каркас, куски, штриховка ---
  await hold(/\/annotations\/singles\?/);
  await page.locator(".tp-vid").getByRole("button", { name: /Размечать ролик/ }).click();
  await page.locator(".ve-tl").waitFor();
  await page.locator(".ve-loading").waitFor({ timeout: 10000 });
  const lanes = await page.locator(".ve-sys").count();
  const hatch = await page.locator(".ve-hatch").count();
  const now = await page.locator(".ve-hatch.now").count();
  await page.screenshot({ path: `${OUT}/load-editor-mid.png` });
  check("редактор: «Разметка грузится» в углу шкалы", true);
  check("редактор: штриховка по кускам на служебных дорожках", hatch > 0 && hatch % 4 === 0, `${hatch} штрихов, ${lanes} дорожек`);
  check("редактор: в пути один кусок", now > 0 && now === hatch / 4, `ползут ${now}`);
  await page.locator(".ve-loading").waitFor({ state: "detached", timeout: 20000 });
  await wait(700);
  const opaque = await page.$$eval(".ve-hatch", (els) => els.filter((e) => Number(getComputedStyle(e).opacity) > 0.01).length);
  check("редактор: пришедшие куски погасли", opaque === 0, `видимых штрихов ${opaque}`);
  await page.unroute(/\/annotations\/singles\?/);

  // --- плашка агента и стрелки ---
  const frameNo = async () => Number((await page.locator(".ve-pos .ui-mono").first().innerText()).trim());
  const bar = page.locator(".ed-review");
  check("плашка агента со стрелками", await bar.locator(".ed-review-go").count() === 2);
  const f0 = await frameNo();
  await bar.getByRole("button", { name: /Следующий кадр на проверке/ }).click();
  const f1 = await frameNo();
  check("стрелка ведёт к следующему кадру на проверке", f1 === f0 + 2, `${f0} → ${f1}`);
  await page.keyboard.press("ArrowRight");
  await wait(200);
  const calm = await page.locator(".ed-review.calm").innerText().catch(() => "");
  check("на кадре без непроверенного плашка сжата", /ещё\s*150\s*кадров/.test(calm), calm.replace(/\s+/g, " "));

  // --- масштаб ---
  const lane = await page.locator(".ve-ruler .ve-l").boundingBox();
  await page.mouse.move(lane.x + lane.width / 2, lane.y + 10);
  await page.keyboard.down("Control");
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await wait(200);
  const zoom = await page.locator(".ve-zoom b").innerText();
  check("Ctrl+колесо приближает", zoom !== "×1", zoom);
  check("полоса прокрутки окна видна", await page.locator(".ve-hbar").count() === 1);
  await page.screenshot({ path: `${OUT}/load-editor-zoom.png` });
  await page.locator(".ve-zoom").getByRole("button", { name: "Весь" }).click();
  check("«Весь» возвращает ролик целиком", (await page.locator(".ve-zoom b").innerText()) === "×1");
} catch (e) {
  console.log("✗ проба упала:", e.message);
  await page.screenshot({ path: `${OUT}/load-fail.png` }).catch(() => {});
} finally {
  if (temp) await page.request.delete(`${BASE}/api/projects/${temp}`).catch(() => {});
  console.log("ошибки страницы:", errors.length ? errors.slice(0, 5) : "нет");
  await browser.close();
}
