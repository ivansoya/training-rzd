/** Проба страницы таски 21.10.2026: «размечает Имя» только при человеке в ролике, «агент размечает» только на
 *  ролике под курсором прогона, «Продолжить» у остановленного прогона и после перезагрузки, пульс из редактора.
 *  Временный проект tester, два ролика на разметку. Ход агента подставляется в ответ сервера (сам агент не нужен),
 *  остановленный прогон кладётся в базу. В конце проект удаляется. Запуск:
 *  docker exec -w /work/tests/e2e -e NODE_PATH=/opt/e2e/node_modules yolo-tests node statusprobe.mjs */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend:81";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch(existsSync("/opt/google/chrome/chrome") ? { channel: "chrome" } : {});
const page = await browser.newPage({ viewport: { width: Number(process.env.W || 1280), height: 900 } });
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
const me = sql("SELECT id, display_name FROM users WHERE login = 'tester'")[0];

let temp = null;
try {
  const proj = await api("POST", "/api/projects", { name: `test-status-${Date.now() % 100000}` });
  temp = proj.code;
  await api("POST", `/api/projects/${temp}/classes`, { name: "вагон" });
  const task = await api("POST", `/api/projects/${temp}/tasks`, { name: "Проба состояний роликов" });
  await api("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
  const videos = [];
  for (const name of ["pervyj.mp4", "vtoroj.mp4"]) {
    const up = await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
      multipart: { file: { name, mimeType: "video/mp4", buffer: readFileSync("/tmp/magistral-sample-300f.mp4") }, mode: "annotate" },
    });
    videos.push(await up.json());
  }
  const row = (i) => page.locator(".tp-vid", { hasText: videos[i].file_name });
  const pageUrl = `${BASE}/projects/${temp}/tasks/${task.id}`;
  await page.goto(pageUrl);
  await row(1).waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);

  // --- никого нет — значка нет ------------------------------------------------ //
  check("«размечается» больше не висит", await page.getByText("размечается").count() === 0, await page.getByText("размечается").count());
  check("без людей — ни одного «размечает»", await page.locator(".tp-here").count() === 0, await page.locator(".tp-here").count());

  // --- человек в первом ролике ------------------------------------------------ //
  const here = (v, off) => page.evaluate(async ([t, id, o]) => (await fetch(`/api/tasks/${t}/videos/${id}/here${o ? "?off=1" : ""}`,
    { method: "POST" })).status, [task.id, v.id, off]);
  check("пульс принят", await here(videos[0], false) === 204, null);
  const badge = row(0).locator(".tp-here");
  await badge.waitFor({ timeout: 5000 }).catch(() => null);
  check("на первом «размечает Имя»", (await badge.innerText().catch(() => "")) === `размечает ${me[1]}`, await badge.innerText().catch(() => "нет"));
  check("на втором — пусто", await row(1).locator(".tp-here").count() === 0, await row(1).locator(".tp-here").count());
  const bb = await badge.boundingBox();
  const btn = await row(0).getByRole("button", { name: /Размечать ролик|Смотреть/ }).boundingBox();
  check("значок не наезжает на кнопку", bb && btn && bb.x + bb.width <= btn.x, [bb, btn]);
  await page.screenshot({ path: `${OUT}/status-here.png` });
  await here(videos[0], true);
  await badge.waitFor({ state: "detached", timeout: 5000 }).catch(() => null);
  check("«ушёл» гасит сразу", await badge.count() === 0, await badge.count());

  // --- агент идёт по второму ролику (ход подставлен в ответ сервера) --------------- //
  const fake = (body) => ({
    ...body, runs: [{
      id: "00000000-0000-0000-0000-000000000001", status: "running", processed: 40, total: 120, stats: { cursor: [1, 40] },
      error: null, queue_reason: null, agent: "Проба", version: 1, sources: [], mode: "annotate",
      videos: videos.map((v) => v.id), created_at: new Date().toISOString(), finished_at: null,
    }, ...body.runs],
  });
  await page.route(`**/api/agents/tasks/${task.id}`, async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: fake(await res.json()) });
  });
  await page.reload();
  await row(1).waitFor({ timeout: 20000 });
  const agentBadge = page.getByText("агент размечает", { exact: true });
  await agentBadge.first().waitFor({ timeout: 5000 }).catch(() => null);
  check("«агент размечает» — на втором", await row(1).getByText("агент размечает", { exact: true }).count() === 1,
    await row(1).getByText("агент размечает").count());
  check("на первом агента нет", await row(0).getByText("агент размечает").count() === 0, await row(0).getByText("агент размечает").count());
  await page.screenshot({ path: `${OUT}/status-agent.png` });
  await page.unroute(`**/api/agents/tasks/${task.id}`);

  // --- «Продолжить» у остановленного, и после перезагрузки -------------------------- //
  const [[runId]] = sql(`INSERT INTO agent_runs (id, project_id, task_id, params, status, stats, processed, total, created_by, created_at, finished_at)
    SELECT gen_random_uuid(), project_id, id, %s, 'stopped', %s, 30, 300, %s, now(), now() FROM tasks WHERE id = %s RETURNING id`,
    [JSON.stringify({ mode: "annotate", videos: [videos[0].id] }), JSON.stringify({ cursor: [0, 120] }), me[0], task.id]);
  await page.reload();
  const bar = page.locator(".ar-bar");
  await bar.waitFor({ timeout: 10000 }).catch(() => null);
  check("после перезагрузки плашка остановленного", (await bar.innerText().catch(() => "")).includes("остановлен"), await bar.innerText().catch(() => "нет"));
  const go = bar.getByRole("button", { name: "Продолжить" });
  check("кнопка «Продолжить»", await go.count() === 1, await go.count());
  await page.screenshot({ path: `${OUT}/status-resume.png` });
  await go.click();
  await page.waitForTimeout(1500);
  const after = sql("SELECT status::text, stats::text FROM agent_runs WHERE id = %s", [runId])[0];
  check("прогон снова пошёл (у пробы нет версии — воркер его роняет)", after[0] !== "stopped" && after[1].includes("[0, 120]"), after);
  await page.getByText("Версии агента больше нет.").waitFor({ timeout: 20000 }).catch(() => null);
  check("упавший — снова «Продолжить»", await bar.getByRole("button", { name: "Продолжить" }).count() === 1, await bar.innerText().catch(() => "нет"));
  await bar.getByRole("button", { name: "Скрыть" }).click();
  await page.reload();
  await row(1).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  check("скрытый не всплывает при новом заходе", await page.locator(".ar-bar").count() === 0, await page.locator(".ar-bar").count());

  // --- пульс из редактора ролика ---------------------------------------------------- //
  const beats = [];
  page.on("request", (r) => r.url().includes("/here") && beats.push(r.url().endsWith("off=1") ? "off" : "on"));
  const open = row(0).getByRole("button", { name: "Размечать ролик" });
  for (let i = 0; i < 120 && await open.isDisabled(); i++) await page.waitForTimeout(1000);
  await open.click();
  await page.waitForTimeout(4000);
  check("редактор шлёт пульс", beats.includes("on"), beats);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2000);
  check("закрыл — «ушёл»", beats.at(-1) === "off", beats);
} finally {
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  for (const [ok, what, got] of checks) console.log(ok, what, "—", typeof got === "string" ? got : JSON.stringify(got));
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
