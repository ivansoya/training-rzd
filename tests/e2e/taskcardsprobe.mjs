/** Проба карточек тасок (решения 14.10.2026): счёт «сделано · осталось», ролики треками и проверкой агента,
 *  «Готово» всеми изображениями — и что на узкой доске ничего не наезжает и не вылезает за карточку.
 *  Временный проект tester; рамки агента кладутся в базу напрямую; в конце проект удаляется.
 *
 *   docker exec -w /work/tests/e2e -e BASE=http://localhost:8097 yolo-tests node taskcardsprobe.mjs */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://localhost:8097";
const PASS = process.env.PASS || "123456";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch(existsSync("/opt/google/chrome/chrome") ? { channel: "chrome" } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/401|404/.test(m.text()) && errors.push(m.text()));

const sql = (query, params = []) => execFileSync("python3", ["-c", `
import json, os, sys, psycopg2
c = psycopg2.connect(os.environ.get("TEST_DB_DSN", "postgresql://app:app@db:5432/app")); c.autocommit = True
cur = c.cursor(); cur.execute(sys.argv[1], json.loads(sys.argv[2]))
`, query, JSON.stringify(params)]);

await page.goto(BASE + "/");
await page.evaluate(async (pass) => fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: pass }),
}), PASS);
const api = async (method, url, data) => {
  const r = await page.request.fetch(BASE + url, { method, data });
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? null : r.json();
};
const jpeg = (hue) => page.evaluate(async (h) => {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 400;
  const g = c.getContext("2d");
  g.fillStyle = `hsl(${h} 25% 30%)`; g.fillRect(0, 0, 640, 400);
  const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  return [...new Uint8Array(await b.arrayBuffer())];
}, hue);
let fails = 0;
const check = (what, ok, got = "") => { if (!ok) fails++; console.log(`${ok ? "ок " : "НЕТ"} ${what}${got !== "" ? ` — ${got}` : ""}`); };

let temp = null;
try {
  const proj = await api("POST", "/api/projects", { name: `test-cards-${Date.now() % 100000}` });
  temp = proj.code;
  const cls = await api("POST", `/api/projects/${temp}/classes`, { name: "вагон" });
  const task = (name) => api("POST", `/api/projects/${temp}/tasks`, { name }).then(async (t) => {
    await api("POST", `/api/tasks/${t.id}/status`, { status: "in_progress" });
    return t;
  });
  const images = async (t, n) => {
    for (let i = 0; i < n; i++) {
      await page.request.post(`${BASE}/api/tasks/${t.id}/images`, {
        multipart: { files: { name: `k-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(await jpeg(i * 40)) } },
      });
    }
    return (await api("GET", `/api/tasks/${t.id}/images`)).images;
  };
  const box = (img, pending = false) => sql(
    `INSERT INTO annotations (id, image_id, class_id, ann_type, geometry, area, iscrowd, source, pending, attributes, created_at)
     VALUES (gen_random_uuid(), %s, %s, 'bbox', %s, 1600, false, %s, %s, '{}', now())`,
    [img.id, cls.id, JSON.stringify({ x: 10, y: 10, w: 40, h: 40 }), pending ? "model" : "human", pending]);
  const state = (img, st) => sql("UPDATE images SET task_status = %s WHERE id = %s", [st, img.id]);
  const video = async (t) => {
    const up = await page.request.post(`${BASE}/api/tasks/${t.id}/videos`, {
      multipart: { file: { name: "perehod.mp4", mimeType: "video/mp4", buffer: readFileSync("/tmp/review-h264.mp4") }, mode: "annotate" },
    });
    const v = await up.json();
    for (let k = 0; k < 60; k++) {
      const r = await page.request.post(`${BASE}/api/tasks/${t.id}/videos/${v.id}/tracks`,
        { data: { class_index: cls.class_index, frame_no: 0, geometry: { x: 10, y: 90, w: 60, h: 60 } } });
      if (r.status() === 201) return { v, track: await r.json() };
      await page.waitForTimeout(1500);
    }
    throw new Error("ролик не готов");
  };
  const pend = (v, f) => sql(`INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source, pending, attributes, created_at)
    VALUES (gen_random_uuid(), %s, %s, %s, 'bbox', %s, 'model', true, '{}', now())`, [v.id, f, cls.id, JSON.stringify({ x: 5, y: 5, w: 50, h: 50 })]);

  // А: изображения во всех состояниях
  const a = await task("Изображения во всех состояниях кадра с очень длинным именем таски для переноса");
  const ai = await images(a, 8);
  ai.slice(0, 3).forEach((im) => { box(im); state(im, "annotated"); });
  state(ai[3], "empty"); state(ai[4], "skipped"); state(ai[5], "deleted"); box(ai[6], true);
  // Б: ролик без агента
  const b = await task("Ролик без агента");
  const bv = await video(b);
  await api("PUT", `/api/tasks/${b.id}/videos/${bv.v.id}/frames/10/boxes`, { boxes: [{ class_index: cls.class_index, x: 5, y: 5, w: 20, h: 20 }] });
  // В: ролик с агентом — 3 кадра агента, на одном ждёт проверки
  const c = await task("Ролик с агентом");
  const cv = await video(c);
  pend(cv.v, 40);
  sql("UPDATE task_videos SET agent_frames = '[20, 30, 40]' WHERE id = %s", [cv.v.id]);
  // Г: смешанная
  const d = await task("Смешанная: изображения и ролик");
  const di = await images(d, 3);
  box(di[0]); state(di[0], "annotated"); state(di[1], "skipped");
  await video(d);
  // Д: сданная с кадрами ролика, Е: закрытая
  const e = await task("Сданная с роликом");
  const ei = await images(e, 2);
  box(ei[0]); state(ei[0], "annotated");
  const ev = await video(e);
  await api("PATCH", `/api/video-tracks/${ev.track.id}`, { export_step: 10 });
  await api("PUT", `/api/video-tracks/${ev.track.id}/keys/40`, { geometry: { x: 50, y: 90, w: 60, h: 60 } });
  await api("POST", `/api/tasks/${e.id}/status`, { status: "done" });
  const f = await task("Закрытая");
  const fi = await images(f, 2);
  box(fi[0]); state(fi[0], "annotated");
  await api("POST", `/api/tasks/${f.id}/status`, { status: "done" });
  for (let k = 0; k < 40; k++) {
    const s = await api("GET", `/api/tasks/${e.id}/summary`);
    if (!s.handover) break;
    await page.waitForTimeout(1500);
  }
  await api("POST", `/api/tasks/${f.id}/status`, { status: "closed" }).catch((x) => console.log("закрыть:", x.message));

  await page.goto(`${BASE}/projects/${temp}/tasks`);
  await page.waitForTimeout(3000);
  const line = async (name) => {
    const card = page.locator(".tb-card", { hasText: name }).first();
    return {
      line: (await card.locator(".tb-line").innerText()).trim(),
      badges: (await card.locator(".tb-badges .ui-badge").allInnerTexts()).map((x) => x.trim()),
      foot: (await card.locator(".tb-foot").count()) ? (await card.locator(".tb-foot").innerText()).replace(/\s+/g, " ").trim() : "",
    };
  };
  const A = await line("Изображения во всех");
  check("изображения: сделано 5 (3 + фон + брак) · осталось 2", A.line === "сделано 5 · осталось 2", A.line);
  check("значки: ждут проверки и отложено", A.badges.join(" | ") === "1 ждут проверки | 1 отложено", A.badges.join(" | "));
  const B = await line("Ролик без агента");
  check("ролик без агента: 1 трек · 1 рамка", B.line === "1 трек · 1 рамка", B.line);
  const C = await line("Ролик с агентом");
  check("ролик с агентом: проверено 2 · осталось 1", C.line === "проверено 2 · осталось 1", C.line);
  const D = await line("Смешанная");
  check("смешанная: строка изображений, ролик значком", D.line === "сделано 1 · осталось 1" && D.badges.some((x) => x.startsWith("ролик:")),
    `${D.line} / ${D.badges.join(" | ")}`);
  const E = await line("Сданная с роликом");
  check("сданная: все изображения с кадрами ролика", /^\d+ изображени/.test(E.line) && E.foot.includes("сдана"), `${E.line} / ${E.foot}`);
  const F = page.locator(".tb-card.closed", { hasText: "Закрытая" });
  if (await F.count()) console.log("   закрытая:", (await F.locator(".tb-line").innerText()).trim());

  // Ничего не вылезает за карточку, строки зоны не пересекаются, строка чисел видна целиком — на двух ширинах окна
  for (const width of [1280, 1600]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(400);
  const bad = await page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll(".tb-card")) {
      const r = card.getBoundingClientRect();
      const name = card.querySelector(".tb-name")?.textContent?.slice(0, 24);
      for (const el of card.querySelectorAll(".tb-zone > *, .tb-foot, .tb-src, .tb-card-h, .tb-badges .ui-badge, .tb-foot > span")) {
        const q = el.getBoundingClientRect();
        if (q.width && (q.right > r.right - 1 || q.left < r.left)) out.push(`${name}: ${el.className} шире карточки (${Math.round(q.right - r.right)} px)`);
      }
      const zone = [...card.querySelectorAll(".tb-zone > *")].map((x) => x.getBoundingClientRect());
      for (let i = 1; i < zone.length; i++) if (zone[i].top < zone[i - 1].bottom - 0.5) out.push(`${name}: строки зоны наезжают`);
      const foot = card.querySelector(".tb-foot");
      if (foot && foot.scrollWidth > foot.clientWidth + 1) out.push(`${name}: подвал не влез`);
      const ln = card.querySelector(".tb-line");
      if (ln && !card.classList.contains("closed") && (ln.scrollHeight > ln.clientHeight + 1 || ln.scrollWidth > ln.clientWidth + 1))
        out.push(`${name}: строка чисел обрезана «${ln.textContent}»`);
    }
    return out;
  });
  check(`ничего не вылезает и не обрезано, строки не наезжают (окно ${width})`, bad.length === 0, bad.join("; "));
  await page.screenshot({ path: `${OUT}/cards-board-${width}.png`, fullPage: true });
  }

  await page.goto(`${BASE}/projects/${temp}`);
  await page.waitForTimeout(3000);
  const ov = await page.locator(".ov-tasks li").evaluateAll((els) => els.map((li) => {
    const r = li.getBoundingClientRect();
    const p = li.querySelector(".ov-task-p")?.getBoundingClientRect();
    const n = li.querySelector(".ov-task-n")?.getBoundingClientRect();
    return { text: li.querySelector(".ov-task-p")?.textContent?.trim(), over: !!p && (p.right > r.right + 1 || (n && n.right > p.left + 1 && n.bottom > p.top && n.top < p.bottom)) };
  }));
  check("обзор: строки тем же счётом, без наездов", ov.length > 0 && ov.every((x) => !x.over) && ov.some((x) => x.text?.startsWith("сделано")),
    ov.map((x) => x.text).join(" | "));
  await page.screenshot({ path: `${OUT}/cards-overview.png`, fullPage: true });
  console.log("ошибки страницы:", errors.length ? errors : "нет");
} finally {
  if (temp) await api("DELETE", `/api/projects/${temp}`).catch((e) => console.log("не удалён проект", temp, e.message));
  await browser.close();
  console.log(fails ? `ПРОВАЛОВ: ${fails}` : "всё сошлось");
}
