/** Проба сдачи таски с роликом (решение 14.10.2026): кадры ролика рождаются на «Готово».
 *  Считает, а не смотрит: ход «Сдаётся… N %» у нажавшего, второй исполнитель на время сдачи —
 *  в просмотре, в итоге 300 кадров в датасете и ролик «сдан» у обоих. Данные — taskrightsprobe.py
 *  (всё с приставкой test-) плюс ролик на 300 кадров с треком через весь ролик.
 *  docker exec -w /work/tests/e2e -e NODE_PATH=/opt/e2e/node_modules yolo-tests node handoverprobe.mjs */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = "/work/tests/e2e/test-results";
const d = JSON.parse(execFileSync("python3", ["taskrightsprobe.py"], { encoding: "utf8" }).trim().split("\n").pop());
const browser = await chromium.launch();
const errors = [];
const bad = [];
const check = (ok, what) => { console.log(`${ok ? "OK  " : "FAIL"} ${what}`); if (!ok) bad.push(what); };

async function open(login) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("pageerror", (e) => errors.push(`${login}: ${e.message}`));
  await page.goto(BASE + "/");
  const st = await page.evaluate(async ([identity, password]) => (await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity, password }),
  })).status, [login, d.password]);
  if (st !== 200) throw new Error(`вход ${login}: ${st}`);
  return page;
}
// waitForFunction страница не пускает (CSP без unsafe-eval) — ждём опросом; null — не дождались
async function until(ok, ms = 20000, step = 100) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await ok()) return Date.now() - t;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
}

const anna = await open(d.admin);
const petr = await open(d.petr);
const api = anna.request;
const video = await (await api.post(`${BASE}/api/tasks/${d.task}/videos`, { multipart: {
  file: { name: "проба-300.mp4", mimeType: "video/mp4", buffer: readFileSync("/tmp/magistral-sample-300f.mp4") },
  mode: "annotate",
} })).json();
await until(async () => (await (await api.get(`${BASE}/api/tasks/${d.task}`)).json()).videos[0]?.frame_count, 60000, 500);
const track = await (await api.post(`${BASE}/api/tasks/${d.task}/videos/${video.id}/tracks`, {
  data: { class_index: d.class_index, frame_no: 0, geometry: { x: 10, y: 10, w: 60, h: 60 } } })).json();
await api.put(`${BASE}/api/video-tracks/${track.id}/keys/299`, { data: { geometry: { x: 200, y: 100, w: 60, h: 60 } } });
await api.patch(`${BASE}/api/video-tracks/${track.id}`, { data: { export_step: 1 } });

const taskUrl = `${BASE}/projects/${d.code}/tasks/${d.task}`;
await Promise.all([anna.goto(taskUrl), petr.goto(taskUrl)]);
const vnums = (p) => p.locator(".tp-vnums").first().innerText().catch(() => "");
check(await until(async () => /300\s*уйдёт при сдаче/.test(await vnums(anna))) !== null, "до сдачи на карточке «300 уйдёт при сдаче»");
await petr.waitForTimeout(1500); // живая связь успевает поздороваться
const reelButton = (p, name) => p.locator(".tp-vid").getByRole("button", { name, exact: true });
check(await reelButton(petr, "Размечать ролик").count() === 1, "второй исполнитель до сдачи размечает ролик");

const t0 = Date.now();
await anna.getByRole("button", { name: "Готово", exact: true }).click();
const seen = await until(async () => (await anna.locator(".tp-pass").innerText()).includes("Сдаётся"), 5000, 30);
check(seen !== null, `у нажавшего «Сдаётся… N %» через ${seen} мс`);
check(await anna.getByRole("button", { name: "Готово", exact: true }).count() === 0, "кнопки «Готово» на время сдачи нет");
await anna.screenshot({ path: `${OUT}/handover-progress.png` });
const petrView = await until(async () => await reelButton(petr, "Смотреть").count() === 1, 5000, 30);
check(petrView !== null, `второй исполнитель ушёл в просмотр через ${petrView} мс`);
check(await petr.locator(".tp-vid").getByText("сдаётся", { exact: true }).count() === 1, "у второго ролик «сдаётся»");

const done = await until(async () => (await anna.locator(".ui-notice").innerText().catch(() => "")).includes("ушло"), 120000, 200);
console.log(`сдача заняла ${done === null ? "—" : Date.now() - t0} мс; итог: «${await anna.locator(".ui-notice").first().innerText().catch(() => "")}»`);
check(done !== null && /ушло 300 кадров/.test(await anna.locator(".ui-notice").first().innerText()), "итог «ушло 300 кадров»");
for (const [who, p] of [["нажавший", anna], ["второй", petr]]) {
  const sdan = await until(async () => await p.locator(".tp-vid").getByText("сдан", { exact: true }).count() > 0, 10000);
  check(sdan !== null, `${who}: ролик «сдан»`);
  check(/300\s*в датасете/.test(await vnums(p)), `${who}: «300 в датасете» (${(await vnums(p)).replace(/\s+/g, " ")})`);
}
await anna.screenshot({ path: `${OUT}/handover-done.png` });
const task = await (await api.get(`${BASE}/api/tasks/${d.task}`)).json();
check(task.status === "done" && task.handover === null, `таска «${task.status}», сдача кончилась`);

await browser.close();
console.log(errors.length ? `ошибки страниц: ${errors.join(" | ")}` : "ошибок страниц нет");
console.log(bad.length ? `\nПРОВАЛЫ:\n- ${bad.join("\n- ")}` : "\nвсё сошлось");
process.exit(bad.length || errors.length ? 1 : 0);
