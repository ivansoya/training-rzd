/** Проба: правки редактора — подтверждение из меню и панели, разведка в панели, панель подводит вид к объекту,
 *  выбор после перетаскивания вершины и после «В контур», удаление вершины правой кнопкой. */
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
  await api("POST", `/api/projects/${temp}/classes`, { name: "гайка" });
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

  // полигон-одиночная на кадре 0 ролика
  sql(`INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source, pending, created_at)
       VALUES (gen_random_uuid(), %s, 0, %s, 'polygon', %s, 'human', false, now())`,
  [video.id, man.id, JSON.stringify({ parts: [[[900, 450], [1100, 450], [1150, 600], [1000, 650], [880, 580]]] })]);
  sql(`INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source, pending, created_at)
       VALUES (gen_random_uuid(), %s, 0, %s, 'bbox', %s, 'human', false, now())`,
  [video.id, wagon.id, JSON.stringify({ x: 400, y: 400, w: 150, h: 120 })]);

  const taskUrl = `${BASE}/projects/${temp}/tasks/${task.id}`;
  const settled = async (root) => { await root.locator(".ve-busy").waitFor({ state: "detached", timeout: 30000 }).catch(() => {}); await page.waitForTimeout(900); };

  // --- «Фокус»: подтверждение из меню переживает уход с кадра ------------ #
  await page.goto(taskUrl);
  await page.locator(".tp-src", { hasText: "Изображения" }).getByRole("button", { name: /Проверить/ }).click();
  const fe = page.getByRole("dialog", { name: "Разметка кадров" });
  await fe.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  let hb = await fe.locator(".mag-cv-sh.pending .mag-cv-hit").first().boundingBox();
  await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2, { button: "right" });
  await page.waitForTimeout(300);
  await page.locator(".ed-omenu .ui-opt", { hasText: "Подтвердить" }).click();
  await page.waitForTimeout(1500);
  await page.keyboard.press("ArrowRight"); await page.waitForTimeout(1500);
  await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(1500);
  console.log("Фокус: на проверке после возврата (было 2, подтвердили 1):", await fe.locator(".mag-cv-sh.pending:not(.mag-cv-ov)").count());
  // Панель: «Подтвердить» у раскрытой рамки агента
  await fe.locator(".fe-agent .fe-obj-r").first().click();
  await page.waitForTimeout(300);
  await fe.locator(".fe-agent .fe-confirm button", { hasText: "Подтвердить" }).click();
  await page.waitForTimeout(1500);
  console.log("Фокус: после «Подтвердить» в панели на проверке:", await fe.locator(".mag-cv-sh.pending:not(.mag-cv-ov)").count());
  await page.keyboard.press("Escape"); await page.waitForTimeout(1500);

  // --- видео ---------------------------------------------------------------- #
  await page.goto(taskUrl);
  if (await fe.count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(1500); }
  const open = page.locator(".tp-vid", { hasText: "perehod.mp4" }).getByRole("button", { name: /Проверить|Разметить|Открыть/ }).first();
  await open.waitFor({ timeout: 30000 });
  await open.click();
  const ed = page.getByRole("dialog", { name: "Разметка видео" });
  await ed.waitFor({ timeout: 20000 });
  await settled(ed);
  if (!(await ed.locator(".mag-cv-ghost").count())) { await page.keyboard.press("r"); await page.waitForTimeout(600); }
  await page.screenshot({ path: `${OUT}/fx-video-side.png` });
  console.log("панель: разведка", await ed.locator(".fe-scout .fe-obj").count(), "агент", await ed.locator(".fe-agent .fe-obj").count());

  // 1) подтверждение через меню переживает уход с кадра
  hb = await ed.locator(".mag-cv-sh.pending .mag-cv-hit").first().boundingBox();
  await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2, { button: "right" });
  await page.waitForTimeout(300);
  await page.locator(".ed-omenu .ui-opt", { hasText: "Подтвердить" }).click();
  await page.waitForTimeout(1500);
  await page.keyboard.press("ArrowRight"); await settled(ed);
  await page.keyboard.press("ArrowLeft"); await settled(ed);
  console.log("видео: на проверке после возврата:", await ed.locator(".mag-cv-sh.pending:not(.mag-cv-ov)").count());

  // 4) вершина: тянем — выбор остаётся; правая — вершина уходит
  const polyHit = ed.locator(".mag-cv-sh.poly .mag-cv-hit").first();
  const pb = await polyHit.boundingBox();
  await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.waitForTimeout(300);
  const v = ed.locator(".mag-cv-v").first();
  const vb = await v.boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  await page.mouse.down(); await page.mouse.move(vb.x + 30, vb.y + 20, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(2500);
  console.log("вершина: выбор после отпускания:", await ed.locator(".mag-cv-sh.poly.on:not(.mag-cv-ov)").count(), "вершин:", await ed.locator(".mag-cv-v").count());
  const v2 = await ed.locator(".mag-cv-v").nth(2).boundingBox();
  await page.mouse.click(v2.x + v2.width / 2, v2.y + v2.height / 2, { button: "right" });
  await page.waitForTimeout(2500);
  console.log("правая по вершине: вершин:", await ed.locator(".mag-cv-v").count(), "меню:", await page.locator(".ed-omenu").count());
  if (await page.locator(".ed-omenu").count()) await page.keyboard.press("Escape");

  // 5) выбран полигон, правая по боксу → «В контур» → выбран бокс
  const boxHit = ed.locator(".mag-cv-sh:not(.poly):not(.pending) .mag-cv-hit").first();
  const bb = await boxHit.boundingBox();
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { button: "right" });
  await page.waitForTimeout(300);
  const conv = page.locator(".ed-omenu .ui-opt", { hasText: "В контур" });
  if (await conv.isEnabled()) await conv.click(); else console.log("В контур погашен");
  await page.waitForTimeout(4000);
  console.log("после «В контур»: выбранных", await ed.locator(".mag-cv-sh.on:not(.mag-cv-ov)").count(), "выбран контур бокса (вагон):",
    await ed.locator(".fe-obj.on", { hasText: "вагон" }).count());

  // 3) щелчок в панели подводит к объекту
  const vs = await ed.locator(".mag-cv").first().boundingBox();
  await page.mouse.move(vs.x + 80, vs.y + 80);
  await page.keyboard.down("Control");
  for (let k = 0; k < 6; k++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(60); }
  await page.keyboard.up("Control");
  await page.waitForTimeout(400);
  const row = ed.locator(".fe-objs:not(.fe-scout) .fe-obj-r", { hasText: "человек" }).first();
  await row.click(); await page.waitForTimeout(300);
  if (!(await ed.locator(".fe-obj.on", { hasText: "человек" }).count())) { await row.click(); await page.waitForTimeout(300); }
  await page.waitForTimeout(500);
  const target = await ed.locator(".mag-cv-sh.on .mag-cv-hit").first().boundingBox();
  const inside = target && target.x >= vs.x && target.y >= vs.y && target.x + target.width <= vs.x + vs.width && target.y + target.height <= vs.y + vs.height;
  console.log("панель → вид подведён к объекту:", inside, JSON.stringify(target));
  await page.screenshot({ path: `${OUT}/fx-reveal.png` });

  // 2) разведка в панели: щелчок — выбор находки, «Взять в разметку»
  await page.keyboard.press("0"); await page.waitForTimeout(300);
  const g = ed.locator(".fe-scout .fe-obj-r").first();
  if (await g.count()) {
    await g.click(); await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/fx-scout-row.png` });
    console.log("находка выбрана на кадре:", await ed.locator(".mag-cv-ghost.on").count());
  }
} finally {
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
