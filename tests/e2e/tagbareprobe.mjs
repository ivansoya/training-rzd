/** Проба «таг роликам без тага» (29.10.2026): в обоих блоках роликов рядом с «Таг на все» — «Без тага N», выбор
 *  ставит таг только роликам без тагов, у остальных их таги целы; когда пустых нет или пусты все — пункта нет.
 *  Временный проект tester, в конце удаляется.
 *  docker exec -w /work/tests/e2e -e NODE_PATH=/opt/e2e/node_modules -e BASE=http://localhost:8097 yolo-tests node tagbareprobe.mjs */
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend:81";
const OUT = "/work/tests/e2e/test-results";
const CLIP = "/tmp/magistral-sample-30f.mp4";
const browser = await chromium.launch(existsSync("/opt/google/chrome/chrome") ? { channel: "chrome" } : {});
const page = await browser.newPage({ viewport: { width: Number(process.env.W || 1440), height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const checks = [];
const check = (what, ok, got) => { checks.push([ok ? "ок " : "НЕТ", what, got]); };

await page.goto(BASE + "/");
for (const password of ["VniiTest", "123456"]) {
  const status = await page.evaluate(async (pw) => (await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: pw }),
  })).status, password);
  if (status === 200) break;
}
const api = async (method, url, data) => {
  const r = await page.request.fetch(BASE + url, { method, data });
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? null : r.json();
};
// Черта <Sep /> — скрытая запятая; читаем видимое
const said = (loc) => loc.evaluate((el) => { const c = el.cloneNode(true); c.querySelectorAll(".sep").forEach((s) => s.replaceWith(" | ")); return c.textContent.replace(/\s+/g, " ").trim(); }).catch(() => "");

let temp = null;
try {
  const proj = await api("POST", "/api/projects", { name: `test-tag-bare-${Date.now() % 100000}` });
  temp = proj.code;
  const task = await api("POST", `/api/projects/${temp}/tasks`, { name: "Проба тагов пачкой" });
  await api("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
  const up = async (name, mode) => (await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
    multipart: { file: { name, mimeType: "video/mp4", buffer: readFileSync(CLIP) }, mode },
  })).json();
  const cut = [await up("n1.mp4", "cut"), await up("n2.mp4", "cut"), await up("n3.mp4", "cut")];
  const ann = [await up("r1.mp4", "annotate"), await up("r2.mp4", "annotate")];
  const day = await api("POST", `/api/projects/${temp}/tags`, { name: "день" });
  const night = await api("POST", `/api/projects/${temp}/tags`, { name: "ночь" });
  await api("PUT", `/api/tasks/${task.id}/videos/${cut[0].id}/tags`, { tags: [day.id] });
  await api("PUT", `/api/tasks/${task.id}/videos/${ann[0].id}/tags`, { tags: [day.id] });

  await page.goto(`${BASE}/projects/${temp}/tasks/${task.id}`);
  const cutRow = page.locator(".tp-src", { hasText: "Ролики на нарезку" }).locator(".tp-tagall");
  const annRow = page.locator(".ui-card", { hasText: "Ролики на разметку" }).locator(".tp-tagall");
  await cutRow.waitFor({ timeout: 20000 });
  await annRow.waitFor({ timeout: 20000 });
  const c0 = await said(cutRow), a0 = await said(annRow);
  check("нарезка: «Без тага 2» рядом с «Таг на все 3»", /^Таг на все 3.*\| Без тага 2\s*\+ таг роликам без тага$/.test(c0), c0);
  check("разметка: та же строка, «Без тага 1»", /^Таг на все 2.*\| Без тага 1\s*\+ таг роликам без тага$/.test(a0), a0);
  const box = await cutRow.boundingBox();
  check("строка нарезки в одну строку", box && box.height < 40, box);
  await page.locator(".tp-src", { hasText: "Ролики на нарезку" }).screenshot({ path: `${OUT}/tagbare-before.png` });

  // Нарезка: «ночь» — только двум пустым
  await cutRow.getByRole("button", { name: "+ таг роликам без тага" }).click();
  await cutRow.locator(".tagp-item", { hasText: "ночь" }).click();
  await page.waitForTimeout(1500);
  const vids = (await api("GET", `/api/tasks/${task.id}`)).videos;
  const tagsOf = (id) => (vids.find((v) => v.id === id)?.tag_ids ?? []).map((t) => (t === day.id ? "день" : t === night.id ? "ночь" : t)).join("+");
  const got = cut.map((v) => tagsOf(v.id));
  check("нарезка: день у первого, ночь у двух пустых", got.join(",") === "день,ночь,ночь", got);
  check("разметку не задело", ann.map((v) => tagsOf(v.id)).join(",") === "день,", ann.map((v) => tagsOf(v.id)));
  const c1 = await said(cutRow);
  check("пустых нет — пункта нет", !/Без тага/.test(c1), c1);
  check("разметка: пункт на месте", /Без тага 1/.test(await said(annRow)), await said(annRow));
  await page.locator(".tp-src", { hasText: "Ролики на нарезку" }).screenshot({ path: `${OUT}/tagbare-after.png` });

  // Все пустые — то же, что «на все»: второй кнопки нет
  await api("PUT", `/api/tasks/${task.id}/videos/${ann[0].id}/tags`, { tags: [] });
  await page.reload();
  await annRow.waitFor({ timeout: 20000 });
  const a2 = await said(annRow);
  check("все без тага — только «на все»", /^Таг на все 2/.test(a2) && !/Без тага/.test(a2), a2);
} finally {
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  for (const [ok, what, got] of checks) console.log(ok, what, "—", typeof got === "string" ? got : JSON.stringify(got));
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
