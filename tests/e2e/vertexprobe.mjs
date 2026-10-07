/** Проба: вершины контура ловятся мимо видимого ромба (зона захвата шире), выбор переживает
 *  перетаскивание вершины; снимок цветов рамок агента и разведки в видео. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://localhost:8097";
const OUT = "/work/tests/e2e/test-results";
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

await page.goto(BASE + "/");
await page.evaluate(async () => fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
}));

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
  g.fillStyle = `hsl(${h} 30% 75%)`;
  g.beginPath(); g.ellipse(270, 280, 140, 90, 0.3, 0, Math.PI * 2); g.fill();
  g.fillRect(560, 240, 220, 160);
  const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  return [...new Uint8Array(await b.arrayBuffer())];
}, hue);
// Положение кадра на экране — по нему видно, сбросился ли вид
const frameBox = (root) => root.locator(".mag-cv-frame").first().boundingBox();
const near = (a, b) => a && b && Math.abs(a.x - b.x) < 2 && Math.abs(a.width - b.width) < 2;

let temp = null;
try {
  const proj = await api("POST", "/api/projects", { name: `test-menu-${Date.now() % 100000}` });
  temp = proj.code;
  const wagon = await api("POST", `/api/projects/${temp}/classes`, { name: "вагон" });
  const man = await api("POST", `/api/projects/${temp}/classes`, { name: "человек" });
  const nut = await api("POST", `/api/projects/${temp}/classes`, { name: "гайка" });
  const task = await api("POST", `/api/projects/${temp}/tasks`, { name: "Проба меню" });
  await api("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
  for (const [i, h] of [210, 30, 140].entries()) {
    await page.request.post(`${BASE}/api/tasks/${task.id}/images`, {
      multipart: { files: { name: `kadr-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(await jpeg(h)) } },
    });
  }
  const imgs = (await api("GET", `/api/tasks/${task.id}/images`)).images;
  const ann = (img, cls, x, y, w, h, conf) => sql(
    `INSERT INTO annotations (id, image_id, class_id, ann_type, geometry, area, iscrowd, source, pending, attributes, created_at)
     VALUES (gen_random_uuid(), %s, %s, 'bbox', %s, %s, false, 'model', true, %s, now())`,
    [img, cls, JSON.stringify({ x, y, w, h }), w * h, JSON.stringify({ conf })]);
  ann(imgs[0].id, wagon.id, 120, 180, 300, 200, 0.93);
  ann(imgs[0].id, man.id, 560, 240, 220, 160, 0.61);
  ann(imgs[1].id, wagon.id, 120, 180, 300, 200, 0.8);
  ann(imgs[2].id, wagon.id, 120, 180, 300, 200, 0.7);

  const up = await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
    multipart: { file: { name: "perehod.mp4", mimeType: "video/mp4", buffer: readFileSync("/tmp/review-h264.mp4") }, mode: "annotate" },
  });
  const video = await up.json();
  sql(`INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source, pending, attributes, created_at)
       VALUES (gen_random_uuid(), %s, 0, %s, 'bbox', %s, 'model', true, %s, now())`,
  [video.id, wagon.id, JSON.stringify({ x: 105, y: 80, w: 220, h: 170 }), JSON.stringify({ conf: 0.9 })]);
  const frames = {};
  for (let f = 0; f < 300; f += 25) frames[f] = [["локомотив", 0.8, 700, 150, 260, 180], ["путеец", 0.66, 1000, 300, 80, 200]];
  sql(`INSERT INTO video_scouts (id, video_id, agent_name, step, gap_s, last_frame, frames, segments, created_at)
       VALUES (gen_random_uuid(), %s, 'Путеец', 25, 2, 299, %s, %s, now())`,
  [video.id, JSON.stringify(frames), JSON.stringify({ "локомотив": [[0, 299, 12]], "путеец": [[0, 299, 12]] })]);

  // контуры агента на проверке: кадр 1 (изображение) и кадр 0 ролика
  const ring = [[150, 200], [400, 190], [430, 360], [260, 400], [140, 330]];
  sql(`INSERT INTO annotations (id, image_id, class_id, ann_type, geometry, area, iscrowd, source, pending, attributes, created_at)
       VALUES (gen_random_uuid(), %s, %s, 'polygon', %s, 1, false, 'model', true, %s, now())`,
  [imgs[0].id, man.id, JSON.stringify({ parts: [ring] }), JSON.stringify({ conf: 0.7 })]);
  sql(`INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source, pending, attributes, created_at)
       VALUES (gen_random_uuid(), %s, 0, %s, 'polygon', %s, 'model', true, %s, now())`,
  [video.id, man.id, JSON.stringify({ parts: [ring.map(([x, y]) => [x + 600, y + 150])] }), JSON.stringify({ conf: 0.7 })]);
  // Сверху на вершину [400, 190] выбранного контура ложится другой контур — вершина под ним
  const over = [[350, 150], [500, 150], [500, 260], [350, 260]];
  sql(`INSERT INTO annotations (id, image_id, class_id, ann_type, geometry, area, iscrowd, source, pending, created_at)
       VALUES (gen_random_uuid(), %s, %s, 'polygon', %s, 1, false, 'human', false, now())`,
  [imgs[0].id, nut.id, JSON.stringify({ parts: [over] })]);
  sql(`INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source, pending, created_at)
       VALUES (gen_random_uuid(), %s, 0, %s, 'polygon', %s, 'human', false, now())`,
  [video.id, nut.id, JSON.stringify({ parts: [over.map(([x, y]) => [x + 600, y + 150])] })]);
  const taskUrl = `${BASE}/projects/${temp}/tasks/${task.id}`;
  const settled = async (root) => { await root.locator(".ve-busy").waitFor({ state: "detached", timeout: 30000 }).catch(() => {}); await page.waitForTimeout(900); };

  const dragVertex = async (root, tag) => {
    const hit = root.locator(".mag-cv-sh.poly.pending .mag-cv-hit").first();
    const hb = await hit.boundingBox();
    await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.waitForTimeout(400);
    console.log(tag, "выбран до:", await root.locator(".mag-cv-sh.poly.on:not(.mag-cv-ov)").count(), "вершин:", await root.locator(".mag-cv-v").count());
    for (let n = 0; n < 2; n++) {
      const vb = await root.locator(".mag-cv-v").nth(1).boundingBox();
      // Мимо видимого ромба (радиус 7), но в зоне захвата (13)
      await page.mouse.move(vb.x + vb.width / 2 + 9, vb.y + vb.height / 2);
      await page.mouse.down();
      await page.mouse.move(vb.x + 25 + n * 10, vb.y - 15, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      for (const t of [50, 400, 1500]) {
        await page.waitForTimeout(t);
        console.log(tag, `  через ${t}: выбран`, await root.locator(".mag-cv-sh.on:not(.mag-cv-ov)").count(), "poly.on", await root.locator(".mag-cv-sh.poly.on:not(.mag-cv-ov)").count(),
          "вершин", await root.locator(".mag-cv-v").count(), "панель:", await root.locator(".fe-obj.on .fe-obj-r").allInnerTexts(),
          "ошибка:", await root.locator("[role=alert]").allInnerTexts());
      }
      const va = await root.locator(".mag-cv-v").nth(1).boundingBox({ timeout: 2000 }).catch(() => null);
      if (!va) { await page.screenshot({ path: `${OUT}/vx-lost-${tag}.png` }); return; }
      console.log(tag, "вершина сдвинулась:", Math.round(va.x - vb.x), Math.round(va.y - vb.y));
      console.log(tag, `сразу после отпускания #${n + 1}:`, await root.locator(".mag-cv-sh.poly.on:not(.mag-cv-ov)").count(), "вершин:", await root.locator(".mag-cv-v").count());
      await page.waitForTimeout(2500);
      console.log(tag, `через 2,5 с #${n + 1}:`, await root.locator(".mag-cv-sh.poly.on:not(.mag-cv-ov)").count(), "вершин:", await root.locator(".mag-cv-v").count());
    }
    await page.screenshot({ path: `${OUT}/vx-${tag}.png` });
  };

  await page.goto(taskUrl);
  await page.locator(".tp-src", { hasText: "Изображения" }).getByRole("button", { name: /Проверить/ }).click();
  const fe = page.getByRole("dialog", { name: "Разметка кадров" });
  await fe.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  await dragVertex(fe, "фокус");
  await page.keyboard.press("Escape"); await page.waitForTimeout(1500);

  await page.goto(taskUrl);
  if (await fe.count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(1500); }
  const open = page.locator(".tp-vid", { hasText: "perehod.mp4" }).getByRole("button", { name: /Проверить|Разметить|Открыть/ }).first();
  await open.waitFor({ timeout: 30000 });
  await open.click();
  const ed = page.getByRole("dialog", { name: "Разметка видео" });
  await ed.waitFor({ timeout: 20000 });
  await settled(ed);
  if (!(await ed.locator(".mag-cv-ghost").count())) { await page.keyboard.press("r"); await page.waitForTimeout(600); }
  await page.mouse.move(5, 500);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/vx-colors.png` });
  // Призрак нажимается и изнутри
  const gl = ed.locator(".mag-cv-ghost").first();
  const glb = await gl.boundingBox();
  await page.mouse.click(glb.x + glb.width / 2, glb.y + glb.height / 2);
  await page.waitForTimeout(300);
  console.log("щелчок в середину призрака — выбран:", await ed.locator(".mag-cv-ghost.on").count());
  await page.screenshot({ path: `${OUT}/vx-ghost-in.png` });
  const fr = await ed.locator(".mag-cv-frame").first().boundingBox();
  await page.mouse.click(fr.x + 60, fr.y + fr.height - 60);
  await page.waitForTimeout(300);
  console.log("щелчок по пустому месту — находка выбрана:", await ed.locator(".mag-cv-ghost.on").count());
  await page.mouse.click(glb.x + glb.width / 2, glb.y + glb.height / 2);
  await page.waitForTimeout(300);
  const ob = await ed.locator(".mag-cv-sh.pending:not(.poly):not(.mag-cv-ov) .mag-cv-hit").first().boundingBox();
  await page.mouse.click(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await page.waitForTimeout(300);
  console.log("щелчок по объекту — находка выбрана:", await ed.locator(".mag-cv-ghost.on").count(),
    "объект выбран:", await ed.locator(".mag-cv-sh.on:not(.mag-cv-ov)").count());
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  await dragVertex(ed, "видео");
} finally {
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
