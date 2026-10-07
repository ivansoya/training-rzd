/** Проба: меню объекта (класс кнопкой с подменю, «Подтвердить», «В контур (SAM2)»),
 *  меню и подсветка призрака разведки, вид холста при листании и проигрывании.
 *  Временный проект tester, рамки и разведка кладутся в базу напрямую. В конце проект удаляется.
 *  BASE — через проброс на localhost (forward.mjs): WebCodecs живёт только в защищённом контексте. */
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

  // --- «Фокус» ---------------------------------------------------------- #
  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}`);
  await page.locator(".tp-src", { hasText: "Изображения" }).getByRole("button", { name: /Проверить/ }).click();
  const fe = page.getByRole("dialog", { name: "Разметка кадров" });
  await fe.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  // Ярлык агента — иконка робота, а не ромб
  console.log("иконка агента:", await fe.locator(".mag-cv-lb svg.mag-cv-mark").count(), "ромбов:",
    await fe.locator(".mag-cv-lb", { hasText: "◆" }).count());

  // Зум и сдвиг держатся при переходе к другому кадру
  const stage = fe.locator(".mag-cv-stage, .mag-cv").first();
  const sb = await stage.boundingBox();
  await page.mouse.move(sb.x + sb.width * 0.3, sb.y + sb.height * 0.4);
  await page.keyboard.down("Control");
  for (let k = 0; k < 4; k++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(60); }
  await page.keyboard.up("Control");
  await page.waitForTimeout(300);
  const before = await frameBox(fe);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1200);
  const after = await frameBox(fe);
  console.log("Фокус, вид после перехода:", near(before, after) ? "сохранён" : "СБРОШЕН", before?.width | 0, after?.width | 0);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(1200);
  await page.keyboard.press("0");
  await page.waitForTimeout(400);

  // Меню рамки агента: кнопка класса, подменю, действия
  const hit = fe.locator(".mag-cv-hit").first();
  const hb = await hit.boundingBox();
  await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2, { button: "right" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/mn-focus-menu.png` });
  console.log("пункты меню:", await page.locator(".ed-omenu .ui-opt").allInnerTexts());
  await page.locator(".ed-omenu-cls").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/mn-focus-fly.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  console.log("Escape закрыл подменю, меню осталось:", await page.locator(".ed-omenu-fly").count() === 0, await page.locator(".ed-omenu").count() === 1);
  await page.locator(".ed-omenu .ui-opt", { hasText: "Подтвердить" }).click();
  await page.waitForTimeout(400);
  console.log("на проверке осталось:", await fe.locator(".mag-cv-sh.pending:not(.mag-cv-ov)").count());

  // «В контур (SAM2)» — у второй рамки (ещё на проверке)
  const hit2 = fe.locator(".mag-cv-hit").nth(1);
  const hb2 = await hit2.boundingBox();
  await page.waitForFunction(() => {
    const b = document.querySelector('[aria-label="Полуавтомат"], .ed-tool[aria-label*="SAM"]');
    return !b || !b.hasAttribute("disabled");
  }, null, { timeout: 60000 }).catch(() => {});
  for (let k = 0; k < 30; k++) {
    await page.mouse.click(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2, { button: "right" });
    await page.waitForTimeout(300);
    const item = page.locator(".ed-omenu .ui-opt", { hasText: "В контур" });
    if (await item.isEnabled()) { await item.click(); break; }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/mn-focus-contour.png` });
  console.log("контуров на кадре:", await fe.locator(".mag-cv-sh.poly").count(),
    "на проверке:", await fe.locator(".mag-cv-sh.pending:not(.mag-cv-ov)").count());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);

  // --- видео ------------------------------------------------------------- #
  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}`);
  if (await fe.count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(1500); }
  const open = page.locator(".tp-vid", { hasText: "perehod.mp4" }).getByRole("button", { name: /Проверить|Разметить|Открыть/ }).first();
  await open.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => ![...document.querySelectorAll(".tp-vid button")].some((b) => /Проверить/.test(b.textContent || "") && b.disabled), null, { timeout: 90000 }).catch(() => {});
  await open.click();
  const ed = page.getByRole("dialog", { name: "Разметка видео" });
  await ed.waitFor({ timeout: 20000 });
  await ed.locator(".ve-busy").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  if (!(await ed.locator(".mag-cv-ghost").count())) { await page.keyboard.press("r"); await page.waitForTimeout(600); }

  console.log("размеры:", JSON.stringify(await page.evaluate(() => Object.fromEntries(
    [".ve-body", ".ve-body > .ed-main", ".ve-body .mag-cv", ".ve-body .mag-cv-frame", ".ve-dock"].map((q) => {
      const el = document.querySelector(q); const r = el?.getBoundingClientRect();
      return [q, r ? [Math.round(r.top), Math.round(r.height), el.clientHeight, getComputedStyle(el).overflow] : null];
    })))));
  // Плашка снизу появилась или пропала — кадр стоит на месте
  await page.keyboard.press("0");
  await page.waitForTimeout(400);
  const withBar = await frameBox(ed);
  const bars0 = await ed.locator(".ed-review").count();
  await page.keyboard.press("ArrowRight");
  await ed.locator(".ve-busy").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  const noBar = await frameBox(ed);
  console.log("плашек на кадре 0 / 1:", bars0, await ed.locator(".ed-review").count(),
    "кадр:", near(withBar, noBar) && Math.abs(withBar.y - noBar.y) < 2 ? "на месте" : "ПРЫГНУЛ", JSON.stringify(withBar), JSON.stringify(noBar));
  await page.keyboard.press("ArrowLeft");
  await ed.locator(".ve-busy").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);

  // Наведение на призрак подсвечивает и ярлык
  const ghost = ed.locator(".mag-cv-ghost").first();
  const gb = await ghost.boundingBox();
  if (gb) {
    await page.mouse.move(gb.x + 2, gb.y + gb.height / 2);
    await page.waitForTimeout(250);
    console.log("наведение на призрак → ярлык:", await ed.locator(".mag-cv-lb.ghost.hot").count());
    await page.screenshot({ path: `${OUT}/mn-ghost-hot.png` });
    await page.mouse.click(gb.x + 2, gb.y + gb.height / 2, { button: "right" });
    await page.waitForTimeout(400);
    console.log("меню призрака:", await page.locator(".ed-omenu .ui-opt").allInnerTexts());
    await page.screenshot({ path: `${OUT}/mn-ghost-menu.png` });
    await page.locator(".ed-omenu-cls").click();
    await page.waitForTimeout(300);
    await page.locator(".ed-omenu-fly .ui-opt", { hasText: "гайка" }).click();
    await page.waitForTimeout(1500);
    console.log("взято гайкой:", await ed.locator(".mag-cv-lb", { hasText: "гайка" }).count(),
      "призрак локомотива остался:", await ed.locator(".mag-cv-lb.ghost", { hasText: "локомотив" }).count());
  } else console.log("призраков нет");

  // «В контур» у рамки агента в ролике (кадр 0)
  await page.keyboard.press("Home");
  await page.waitForTimeout(1200);
  const vh = ed.locator(".mag-cv-sh.pending .mag-cv-hit").first();
  const vhb = await vh.boundingBox();
  for (let k = 0; k < 30 && vhb; k++) {
    await page.mouse.click(vhb.x + vhb.width / 2, vhb.y + vhb.height / 2, { button: "right" });
    await page.waitForTimeout(300);
    const item = page.locator(".ed-omenu .ui-opt", { hasText: "В контур" });
    if (k % 5 === 0) console.log("  видео, пункт:", await item.count() ? JSON.stringify(await item.innerText()) : "нет", await item.count() ? await item.isEnabled() : "");
    if (await item.count() && await item.isEnabled()) { await item.click(); console.log("  нажат на попытке", k); break; }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
  console.log("видео: контуров на кадре:", await ed.locator(".mag-cv-sh.poly").count(), "ошибка:", await ed.locator(".ed-err, .ui-alert, [role=alert]").allInnerTexts());
  await page.screenshot({ path: `${OUT}/mn-video-contour.png` });

  // Вид при проигрывании не сбрасывается
  const vs = await ed.locator(".mag-cv").first().boundingBox();
  await page.mouse.move(vs.x + vs.width * 0.7, vs.y + vs.height * 0.3);
  await page.keyboard.down("Control");
  for (let k = 0; k < 4; k++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(60); }
  await page.keyboard.up("Control");
  await page.waitForTimeout(300);
  const v0 = await frameBox(ed);
  await page.keyboard.press("Space");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Space");
  await page.waitForTimeout(500);
  const v1 = await frameBox(ed);
  console.log("видео, вид после проигрывания:", near(v0, v1) ? "сохранён" : "СБРОШЕН", v0?.width | 0, v1?.width | 0);
  await page.screenshot({ path: `${OUT}/mn-video-zoom.png` });
} finally {
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
