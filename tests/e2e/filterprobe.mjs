/** Проба фильтра классов (решения 14.10.2026): лента «Фокуса» и дорожки видео.
 *  Временный проект tester, разметка агента и разведка кладутся в базу напрямую; в конце проект удаляется.
 *  Ролик — H.264 в /tmp/review-h264.mp4 контейнера тестов. BASE — через forward.mjs на vite.
 *
 *   docker exec -w /work/tests/e2e -e BASE=http://localhost:8097 yolo-tests node filterprobe.mjs */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://localhost:8097";
const PASS = process.env.PASS || "123456";
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
  c.width = 960; c.height = 600;
  const g = c.getContext("2d");
  g.fillStyle = `hsl(${h} 25% 30%)`; g.fillRect(0, 0, 960, 600);
  const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  return [...new Uint8Array(await b.arrayBuffer())];
}, hue);
let fails = 0;
const check = (what, ok, got = "") => { if (!ok) fails++; console.log(`${ok ? "ок " : "НЕТ"} ${what}${got !== "" ? ` — ${got}` : ""}`); };
const pop = page.locator(".flt-pop");
const only = async (name) => {
  const row = pop.locator(".flt-row", { hasText: name });
  await row.hover();
  await row.locator(".flt-only").click();
  await page.waitForTimeout(250);
};

let temp = null;
try {
  const proj = await api("POST", "/api/projects", { name: `test-filter-${Date.now() % 100000}` });
  temp = proj.code;
  const wagon = await api("POST", `/api/projects/${temp}/classes`, { name: "вагон" });
  const man = await api("POST", `/api/projects/${temp}/classes`, { name: "человек" });
  const nut = await api("POST", `/api/projects/${temp}/classes`, { name: "гайка" });
  const task = await api("POST", `/api/projects/${temp}/tasks`, { name: "Проба фильтра" });
  await api("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
  for (let i = 0; i < 6; i++) {
    await page.request.post(`${BASE}/api/tasks/${task.id}/images`, {
      multipart: { files: { name: `kadr-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(await jpeg(i * 50)) } },
    });
  }
  const imgs = (await api("GET", `/api/tasks/${task.id}/images`)).images.sort((a, b) => a.file_name.localeCompare(b.file_name));
  const ann = (img, cls, pending = false) => sql(
    `INSERT INTO annotations (id, image_id, class_id, ann_type, geometry, area, iscrowd, source, pending, attributes, created_at)
     VALUES (gen_random_uuid(), %s, %s, 'bbox', %s, 1600, false, %s, %s, %s, now())`,
    [img.id, cls.id, JSON.stringify({ x: 100, y: 100, w: 40, h: 40 }), pending ? "model" : "human", pending,
      JSON.stringify(pending ? { conf: 0.8 } : {})]);
  // 1 вагон · 2 человек · 3 гайка · 4 вагон+человек · 5 пусто · 6 гайка агента на проверке
  ann(imgs[0], wagon); ann(imgs[1], man); ann(imgs[2], nut); ann(imgs[3], wagon); ann(imgs[3], man); ann(imgs[5], nut, true);
  sql("UPDATE images SET task_status = 'annotated' WHERE id = ANY(%s::uuid[])", [[imgs[0].id, imgs[1].id, imgs[2].id, imgs[3].id]]);

  // --- «Фокус» ---------------------------------------------------------- #
  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}?frame=${imgs[0].id}`);
  const fe = page.getByRole("dialog", { name: "Разметка кадров" });
  await fe.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);
  const cells = fe.locator(".fe-film .mag-fs-cell");
  const pos = async () => `${(await fe.locator(".fe-pos").innerText()).trim()} ${await fe.locator(".fe-of").count() ? await fe.locator(".fe-of").innerText() : ""}`.trim();
  check("без фильтра в ленте все 6 кадров", await cells.count() === 6, await cells.count());
  // Кадры ленты — по именам файлов (порядок в таске свой), номера на превью — места в таске
  const names = async () => (await cells.evaluateAll((els) => els.map((e) => Number((e.title.match(/kadr-(\d+)/) || [])[1]))));
  const which = async () => (await names()).sort((a, b) => a - b).join(",");
  const full = await names();
  const labels = async () => (await fe.locator(".fe-film .mag-fs-n").allInnerTexts()).join(",");
  const wanted = async () => (await names()).map((n) => full.indexOf(n) + 1).join(",");
  await fe.locator(".fe-flt").click();
  await pop.waitFor();
  check("в списке три класса с числами кадров", (await pop.locator(".flt-row").allInnerTexts()).join(" | ").replace(/\s+/g, " ") === "вагон 2 | человек 2 | гайка 2",
    (await pop.locator(".flt-row").allInnerTexts()).join(" | ").replace(/\s+/g, " "));
  await only("вагон");
  check("«только вагон» — кадры 1 и 4", await cells.count() === 2, await cells.count());
  check("счётчик «1 / 2 из 6»", (await pos()) === "1 / 2 из 6", await pos());
  check("кнопка подсвечена, плашка «1»", await fe.locator(".fe-flt.on .fr-fcount").innerText() === "1");
  await page.screenshot({ path: `${OUT}/flt-focus-only.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Esc закрыл список, редактор открыт", await pop.count() === 0 && await fe.count() === 1);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(900);
  check("→ перешагнул на кадр 4", (await fe.locator(".ed-title > span").innerText()).includes("kadr-4"), await fe.locator(".ed-title > span").innerText());
  check("номер на миниатюре — место кадра в таске", (await labels()) === (await wanted()) && (await which()) === "1,4",
    `${await labels()} (кадры ${await which()})`);

  // Текущий кадр перестал подходить — остаётся с пунктиром и уходит при уходе
  await fe.locator(".fe-flt").click();
  await pop.waitFor();
  await only("гайка");
  check("«только гайка» на кадре 4: лента 3, 4, 6, кадр 4 с пунктиром",
    (await which()) === "3,4,6" && (await fe.locator(".mag-fs-cell.out").getAttribute("title"))?.includes("kadr-4"), await which());
  await page.screenshot({ path: `${OUT}/flt-focus-out.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await fe.locator('.mag-fs-cell[title^="kadr-6"]').click();
  await page.waitForTimeout(900);
  check("ушли с кадра 4 — он выпал", (await which()) === "3,6" && await fe.locator(".mag-fs-cell.out").count() === 0, await which());
  check("плашка проверки на кадре агента", await fe.locator(".ed-review").count() === 1);

  // Ноль кадров
  await fe.locator(".fe-flt").click();
  await pop.waitFor();
  await pop.locator(".flt-row", { hasText: "гайка" }).locator("input").uncheck();
  await page.waitForTimeout(300);
  check("ноль кадров: «Нет кадров…» и «— / 0»", await fe.locator(".fe-film-none").count() === 1 && (await pos()).startsWith("— / 0"), await pos());
  await page.screenshot({ path: `${OUT}/flt-focus-zero.png` });
  await page.keyboard.press("Escape");
  await fe.locator(".fe-film-none").getByRole("button", { name: "Сбросить" }).click();
  await page.waitForTimeout(300);
  check("«Сбросить» вернул все кадры", await cells.count() === 6, await cells.count());

  // Память: снятое переживает перезагрузку
  await fe.locator(".fe-flt").click();
  await pop.waitFor();
  await only("человек");
  await page.keyboard.press("Escape");
  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}?frame=${imgs[1].id}`);
  await fe.waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  check("после перезагрузки фильтр на месте: кадры 2 и 4", (await which()) === "2,4", await which());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // --- видео ------------------------------------------------------------- #
  const up = await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
    multipart: { file: { name: "perehod.mp4", mimeType: "video/mp4", buffer: readFileSync("/tmp/review-h264.mp4") }, mode: "annotate" },
  });
  const video = await up.json();
  const vbase = `/api/tasks/${task.id}/videos/${video.id}`;
  let track = null;
  for (let k = 0; k < 60 && !track; k++) {
    const r = await page.request.post(`${BASE}${vbase}/tracks`, { data: { class_index: wagon.class_index, frame_no: 0, geometry: { x: 10, y: 90, w: 60, h: 60 } } });
    if (r.status() === 201) track = await r.json(); else await page.waitForTimeout(1500);
  }
  if (!track) throw new Error("ролик не готов к разметке");
  const manTrack = await api("POST", `${vbase}/tracks`, { class_index: man.class_index, frame_no: 50, geometry: { x: 200, y: 90, w: 60, h: 60 } });
  await api("PUT", `${vbase}/frames/10/boxes`, { boxes: [{ class_index: nut.class_index, x: 5, y: 5, w: 20, h: 20 }] });
  await api("PUT", `${vbase}/frames/20/boxes`, { boxes: [{ class_index: wagon.class_index, x: 5, y: 5, w: 20, h: 20 }] });
  const pend = (f, cls) => sql(`INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source, pending, attributes, created_at)
    VALUES (gen_random_uuid(), %s, %s, %s, 'bbox', %s, 'model', true, %s, now())`,
  [video.id, f, cls.id, JSON.stringify({ x: 105, y: 80, w: 120, h: 70 }), JSON.stringify({ conf: 0.9 })]);
  pend(30, man); pend(40, nut);
  const frames = {};
  for (let f = 0; f < 300; f += 25) frames[f] = [["локомотив", 0.8, 300, 150, 100, 80]];
  sql(`INSERT INTO video_scouts (id, video_id, agent_name, step, gap_s, last_frame, frames, segments, created_at)
       VALUES (gen_random_uuid(), %s, 'Путеец', 25, 2, 299, %s, %s, now())`,
  [video.id, JSON.stringify(frames), JSON.stringify({ "локомотив": [[0, 299, 12]] })]);

  const skel = await api("GET", `${vbase}/annotations?singles=0`);
  check("сводка несёт классы непроверенного", JSON.stringify(skel.marks) ===
    JSON.stringify([[10, 1, 0, []], [20, 1, 0, []], [30, 1, 1, [man.class_index]], [40, 1, 1, [nut.class_index]]]), JSON.stringify(skel.marks));

  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}`);
  const open = page.locator(".tp-vid", { hasText: "perehod.mp4" }).getByRole("button", { name: /Проверить|Разметить|Открыть/ }).first();
  await open.waitFor({ timeout: 30000 });
  await open.click();
  const ed = page.getByRole("dialog", { name: "Разметка видео" });
  await ed.waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);
  const tracks = ed.locator(".ve-r[data-track-id]");
  const agentTicks = ed.locator(".ve-t.agent");
  const singleTicks = ed.locator(".ve-t.single");
  const dots = ed.locator(".ve-sys .ve-t.dot");
  check("без фильтра: 2 трека, 2 риски агента, 2 одиночных, точки разведки",
    await tracks.count() === 2 && await agentTicks.count() === 2 && await singleTicks.count() === 2 && await dots.count() > 0,
    `${await tracks.count()} ${await agentTicks.count()} ${await singleTicks.count()} ${await dots.count()}`);
  check("кнопка «Дорожки 2»", (await ed.locator(".ve-flt").innerText()).replace(/\s+/g, " ").trim() === "Дорожки 2",
    await ed.locator(".ve-flt").innerText());
  await ed.locator(".ve-flt").click();
  await pop.waitFor();
  check("в списке классы и «Агент, без класса»", (await pop.innerText()).includes("Агент, без класса") && await pop.locator(".flt-row").count() === 4,
    (await pop.locator(".flt-row").allInnerTexts()).join(" | ").replace(/\s+/g, " "));
  await only("вагон");
  check("«только вагон»: трек 1, агент 0, одиночных 1, разведки 0",
    await tracks.count() === 1 && await agentTicks.count() === 0 && await singleTicks.count() === 1 && await dots.count() === 0,
    `${await tracks.count()} ${await agentTicks.count()} ${await singleTicks.count()} ${await dots.count()}`);
  check("кнопка «Классы 1 из 4»", (await ed.locator(".ve-flt").innerText()).replace(/\s+/g, " ").trim() === "Классы 1 из 4",
    await ed.locator(".ve-flt").innerText());
  await page.screenshot({ path: `${OUT}/flt-video-only.png` });
  await only("человек");
  check("«только человек»: трек 1, агент 1 (кадр 30)", await tracks.count() === 1 && await agentTicks.count() === 1,
    `${await tracks.count()} ${await agentTicks.count()}`);
  await page.keyboard.press("Escape");
  // Выбранный трек снятого класса остаётся с воронкой
  await ed.locator(`.ve-r[data-track-id="${manTrack.id}"] .ve-n-b`).click();
  await ed.locator(".ve-flt").click();
  await pop.waitFor();
  await only("вагон");
  check("выбранный «человек» виден при «только вагон», с воронкой",
    await tracks.count() === 2 && await ed.locator(`.ve-r[data-track-id="${manTrack.id}"] .flt-x`).count() === 1, await tracks.count());
  await page.screenshot({ path: `${OUT}/flt-video-keep.png` });
  await pop.getByRole("button", { name: "Все" }).click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("«Все» вернул всё", await tracks.count() === 2 && await agentTicks.count() === 2, `${await tracks.count()} ${await agentTicks.count()}`);
  console.log("ошибки страницы:", errors.length ? errors : "нет");
} finally {
  if (temp) await api("DELETE", `/api/projects/${temp}`).catch((e) => console.log("не удалён проект", temp, e.message));
  await browser.close();
  console.log(fails ? `ПРОВАЛОВ: ${fails}` : "всё сошлось");
}
