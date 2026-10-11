/** Проба: «Очистить непроверенное агентов» из меню «⋯» глазами браузера (11.10.2026).
 *  Временный проект tester: два кадра с рамками агента и рамкой человека, ролик на
 *  разметку с непроверенным на двух кадрах. Рамки кладутся в базу напрямую. Проба
 *  считает: пункт есть и красный, число в окне, что осталось в базе, события в истории.
 *  В конце проект удаляется. Запуск:
 *  docker exec -w /work/tests/e2e -e NODE_PATH=/opt/e2e/node_modules yolo-tests node clearprobe.mjs */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend:81";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch(existsSync("/opt/google/chrome/chrome") ? { channel: "chrome" } : {});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/401|404/.test(m.text()) && errors.push(m.text()));

const sql = (query, params = []) => JSON.parse(execFileSync("python3", ["-c", `
import json, os, sys, psycopg2
c = psycopg2.connect(os.environ.get("TEST_DB_DSN", "postgresql://app:app@db:5432/app")); c.autocommit = True
cur = c.cursor(); cur.execute(sys.argv[1], json.loads(sys.argv[2]))
print(json.dumps(cur.fetchall() if cur.description else [], default=str))
`, query, JSON.stringify(params)]).toString());

const checks = [];
const check = (what, ok, got) => { checks.push([ok ? "ок " : "НЕТ", what, got]); };

await page.goto(BASE + "/");
let status = 0;
for (const password of ["VniiTest", "123456"]) {
  status = await page.evaluate(async (pw) => (await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: pw }),
  })).status, password);
  if (status === 200) break;
}
console.log("вход:", status);

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

let temp = null;
try {
  const proj = await api("POST", "/api/projects", { name: `test-clear-${Date.now() % 100000}` });
  temp = proj.code;
  const wagon = await api("POST", `/api/projects/${temp}/classes`, { name: "вагон" });
  const task = await api("POST", `/api/projects/${temp}/tasks`, { name: "Проба очистки агента" });
  await api("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
  for (const [i, h] of [210, 30].entries()) {
    await page.request.post(`${BASE}/api/tasks/${task.id}/images`, {
      multipart: { files: { name: `kadr-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(await jpeg(h)) } },
    });
  }
  const imgs = (await api("GET", `/api/tasks/${task.id}/images`)).images;
  const ann = (img, x, conf) => sql(
    `INSERT INTO annotations (id, image_id, class_id, ann_type, geometry, area, iscrowd, source, pending, attributes, created_at)
     VALUES (gen_random_uuid(), %s, %s, 'bbox', %s, 1600, false, 'model', true, %s, now())`,
    [img, wagon.id, JSON.stringify({ x, y: 100, w: 120, h: 80 }), JSON.stringify({ conf })]);
  // Сначала своя рамка человека: запись кадра заменяет его разметку целиком
  await api("PUT", `/api/images/${imgs[0].id}/annotations`,
    { boxes: [{ class_index: wagon.class_index, x: 700, y: 300, w: 100, h: 100 }] });
  ann(imgs[0].id, 100, 0.93); ann(imgs[0].id, 400, 0.71); ann(imgs[1].id, 200, 0.88);

  const up = await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
    multipart: { file: { name: "perehod.mp4", mimeType: "video/mp4", buffer: readFileSync("/tmp/magistral-sample-300f.mp4") },
      mode: "annotate" },
  });
  const video = await up.json();
  const single = (f, x) => sql(
    `INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source, pending, attributes, created_at)
     VALUES (gen_random_uuid(), %s, %s, %s, 'bbox', %s, 'model', true, %s, now())`,
    [video.id, f, wagon.id, JSON.stringify({ x, y: 90, w: 70, h: 60 }), JSON.stringify({ conf: 0.8 })]);
  single(50, 40); single(50, 180); single(125, 90);

  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}`);
  await page.locator(".tp-src", { hasText: "Изображения" }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);

  // --- блок «Изображения» ---------------------------------------------------- //
  await page.locator(".tp-src", { hasText: "Изображения" }).getByRole("button", { name: "Агент: Изображения" }).click();
  const item = page.locator(".ui-opt", { hasText: "Очистить непроверенное агентов" });
  await item.waitFor({ timeout: 5000 });
  check("пункт в меню блока", await item.count() === 1, await item.count());
  check("пункт красный и живой", (await item.getAttribute("class")).includes("danger") && !(await item.isDisabled()),
    await item.getAttribute("class"));
  check("число кадров у пункта", (await item.innerText()).includes("2 кадра"), await item.innerText());
  await page.screenshot({ path: `${OUT}/clear-menu.png` });
  await item.click();
  const dlg = page.getByRole("dialog", { name: "Очистить непроверенное агентов?" });
  await dlg.waitFor({ timeout: 10000 });
  const dlgText = await dlg.innerText();
  check("окно: точное число", dlgText.includes("Уйдут 3 рамки на 2 кадрах"), dlgText.replace(/\s+/g, " "));
  await page.screenshot({ path: `${OUT}/clear-confirm.png` });
  await dlg.getByRole("button", { name: "Очистить" }).click();
  const notice = page.getByText(/Убраны 3 рамки агентов с 2 кадров/);
  await notice.waitFor({ timeout: 10000 });
  check("надпись после очистки", await notice.count() === 1, await notice.count());
  const left = sql(`SELECT source::text, pending FROM annotations a JOIN images i ON i.id = a.image_id
                    WHERE i.task_id = %s ORDER BY 1`, [task.id]);
  check("на кадрах осталась только рамка человека", JSON.stringify(left) === JSON.stringify([["human", false]]),
    JSON.stringify(left));

  // --- ролик на разметку ------------------------------------------------------ //
  await page.locator(".tp-vid", { hasText: "perehod.mp4" }).getByRole("button", { name: /Ещё: perehod/ }).click();
  const vItem = page.locator(".ui-opt", { hasText: "Очистить непроверенное агентов" });
  await vItem.waitFor({ timeout: 5000 });
  check("число кадров у ролика", (await vItem.innerText()).includes("2 кадра"), await vItem.innerText());
  await page.screenshot({ path: `${OUT}/clear-menu-video.png` });
  await vItem.click();
  const vDlg = page.getByRole("dialog", { name: "Очистить непроверенное агентов?" });
  await vDlg.waitFor({ timeout: 10000 });
  check("окно ролика: точное число", (await vDlg.innerText()).includes("Уйдут 3 рамки на 2 кадрах"),
    (await vDlg.innerText()).replace(/\s+/g, " "));
  await vDlg.getByRole("button", { name: "Очистить" }).click();
  await page.getByText(/Убраны 3 рамки агентов с 2 кадров/).waitFor({ timeout: 10000 });
  const vLeft = sql("SELECT count(*) FROM video_annotations WHERE video_id = %s", [video.id]);
  check("на ролике непроверенного не осталось", vLeft[0][0] === 0, vLeft[0][0]);

  // --- пусто и история --------------------------------------------------------- //
  await page.locator(".tp-src", { hasText: "Изображения" }).getByRole("button", { name: "Агент: Изображения" }).click();
  await page.locator(".ui-opt", { hasText: "Очистить непроверенное агентов" }).click();
  const none = page.getByText("Непроверенного от агентов здесь нет.");
  await none.waitFor({ timeout: 10000 });
  check("второй раз — надпись вместо окна", await none.count() === 1, await none.count());
  const events = (await api("GET", `/api/tasks/${task.id}/events`)).events.filter((e) => e.kind === "agent_cleared");
  check("два события в истории", events.length === 2, events.map((e) => e.payload));
  await page.getByRole("button", { name: /История/ }).first().click().catch(() => null);
  await page.waitForTimeout(600);
  const line = page.getByText(/Очищено непроверенное агентов/).first();
  check("строка в истории таски", await line.count() > 0, await line.count() ? await line.innerText() : "нет");
  await page.screenshot({ path: `${OUT}/clear-history.png` });
} finally {
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  for (const [ok, what, got] of checks) console.log(ok, what, "—", typeof got === "string" ? got : JSON.stringify(got));
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
