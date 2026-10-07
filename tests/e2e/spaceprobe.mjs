/** Проба: зажатый Пробел в «Фокусе» листает вперёд и не возвращается назад, пока пишутся правки. */
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
  for (const [i, h] of Array.from({ length: 40 }, (_, k) => (k * 37) % 360).entries()) {
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

  for (const im of imgs.slice(3)) ann(im.id, wagon.id, 120, 180, 300, 200, 0.8);
  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}`);
  await page.locator(".tp-src", { hasText: "Изображения" }).getByRole("button", { name: /Проверить/ }).click();
  const fe = page.getByRole("dialog", { name: "Разметка кадров" });
  await fe.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  const pos = async () => (await fe.locator(".fe-pos").innerText()).trim();
  console.log("старт:", await pos());
  await fe.locator(".mag-fs-cell").nth(2).click();
  await page.waitForTimeout(1200);
  console.log("щелчок по ленте:", await pos(), "фокус на миниатюре:", await page.evaluate(() => !!document.activeElement?.classList.contains("mag-fs-cell")));
  const keyup = (sel) => page.evaluate((q) => {
    const el = document.querySelector(q); if (!el) return "нет элемента"; el.focus();
    const ev = new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true, cancelable: true });
    el.dispatchEvent(ev); return ev.defaultPrevented;
  }, sel);
  console.log("отпускание Пробела на кнопке погашено:", await keyup(".fe .ed-top button"), "в поле ввода:", await keyup("input[type=text], input:not([type]), input[type=search]"));
  await page.evaluate(() => document.activeElement?.blur());
  for (const round of [1, 2]) {
    if (round === 3) {
      // Кадр выбран щелчком по ленте — миниатюра остаётся в фокусе
      await fe.locator(".mag-film button, .fs-film button, [class*=film] button").nth(2).click().catch((e) => console.log("лента:", String(e.message).slice(0, 120)));
      await page.waitForTimeout(1200);
      console.log("после щелчка по ленте:", await pos(), "фокус:", await page.evaluate(() => document.activeElement?.className));
    }
    // Правка кадра — запись в пути, пока листаем: так рождалась гонка
    const hit = fe.locator(".mag-cv-sh:not(.mag-cv-ov) .mag-cv-hit").first();
    if (await hit.count()) {
      const hb = await hit.boundingBox();
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down(); await page.mouse.move(hb.x + hb.width / 2 + 15, hb.y + hb.height / 2 + 5, { steps: 3 }); await page.mouse.up();
    }
    for (let k = 0; k < (round === 1 ? 90 : 25); k++) { await page.keyboard.down(" "); await page.waitForTimeout(33); if (k % 15 === 0) console.log("   ", k, await pos()); }
    await page.keyboard.up(" ");
    const now = await pos();
    await page.waitForTimeout(3000);
    console.log(`зажатие #${round}: сразу ${now}, через 3 с ${await pos()}`);
    await page.screenshot({ path: `${OUT}/sp-${round}.png` });
  }
} finally {
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
