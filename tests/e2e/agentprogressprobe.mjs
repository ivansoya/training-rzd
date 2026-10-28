/** Проба хода агента 29.10.2026: в плашке «ролик N из M · % · осталось ≈», перелив только у идущего, строки роликов
 *  (разведан / идёт с планом и временем / очередь с местом и «начнётся ≈ через»), погашенные пункты с причиной,
 *  значок на доске, «Разметить нарезанные кадры ролика». Временный проект tester, три ролика на нарезку; прогон
 *  кладётся в базу — воркер обучения на время пробы ОСТАНОВИТЬ, иначе он его подберёт. В конце проект удаляется.
 *  docker stop yolo-training-worker; docker exec -w /work/tests/e2e -e NODE_PATH=/opt/e2e/node_modules
 *    -e BASE=http://host.docker.internal:5173 yolo-tests node agentprogressprobe.mjs; docker start yolo-training-worker */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend:81";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch(existsSync("/opt/google/chrome/chrome") ? { channel: "chrome" } : {});
const page = await browser.newPage({ viewport: { width: Number(process.env.W || 1440), height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/401|404/.test(m.text()) && errors.push(m.text()));

const sql = (query, params = []) => JSON.parse(execFileSync("python3", ["-c", `
import json, os, sys, psycopg2
c = psycopg2.connect(os.environ.get("TEST_DB_DSN", "postgresql://app:app@db:5432/app")); c.autocommit = True
cur = c.cursor(); cur.execute(sys.argv[1], json.loads(sys.argv[2]))
print(json.dumps(cur.fetchall() if cur.description else [], default=str))
`, query, JSON.stringify(params)]).toString());
execFileSync("python3", ["-c", "import sys; sys.path.insert(0, '/work/tests'); import sample; sample.ensure_long()"]);

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

// План разведки как у «Искры» в макете: 1198 + 1798 + 1196 кадров, пройден первый и 640 второго, скорость 1,8 к/с
const PLAN = [1198, 1798, 1196];
const DONE = 1198 + 640;
const text = async (loc) => (await loc.innerText().catch(() => "")).replace(/\s+/g, " ").trim();

let temp = null;
let runId = null;
try {
  const proj = await api("POST", "/api/projects", { name: `test-agent-progress-${Date.now() % 100000}` });
  temp = proj.code;
  await api("POST", `/api/projects/${temp}/classes`, { name: "вагон" });
  const task = await api("POST", `/api/projects/${temp}/tasks`, { name: "Проба хода агента" });
  await api("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
  const videos = [];
  for (const name of ["pervyj.mp4", "vtoroj.mp4", "tretij.mp4"]) {
    const up = await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
      multipart: { file: { name, mimeType: "video/mp4", buffer: readFileSync("/tmp/magistral-sample-300f.mp4") }, mode: "cut" },
    });
    videos.push(await up.json());
  }
  const [projectId] = sql("SELECT project_id FROM tasks WHERE id = %s", [task.id])[0];
  // Точка отсчёта скорости — 100 с назад и 180 кадров: 1,8 к/с, как у SAM 3 на voran
  const stats = (cursor, processed, ago = 100, since = processed - 180) => JSON.stringify({
    plan: PLAN, ...(cursor ? { cursor } : {}), since: [new Date(Date.now() - ago * 1000).toISOString(), since] });
  const putRun = (status, processed, cursor) => sql("UPDATE agent_runs SET status = %s, processed = %s, stats = %s::jsonb WHERE id = %s",
    [status, processed, stats(cursor, processed), runId]);
  [[runId]] = sql(`INSERT INTO agent_runs (id, project_id, task_id, params, status, processed, total, started_at, created_at)
    VALUES (gen_random_uuid(), %s, %s, %s::jsonb, 'running', 0, %s, now() - interval '100 seconds', now()) RETURNING id`,
  [projectId, task.id, JSON.stringify({ mode: "scout", videos: videos.map((v) => v.id), step: 25 }), PLAN.reduce((a, b) => a + b)]);
  putRun("running", DONE, [1, -1]);

  const row = (i) => page.locator(".tp-reel", { hasText: videos[i].file_name });
  const pageUrl = `${BASE}/projects/${temp}/tasks/${task.id}`;
  await page.goto(pageUrl);
  await page.locator(".ar-bar").waitFor({ timeout: 20000 });
  await row(2).locator(".tp-reel-ag").waitFor({ timeout: 10000 });

  // --- идёт: плашка ---------------------------------------------------------- //
  const bar = await text(page.locator(".ar-bar"));
  check("плашка: ролик 2 из 3 · 43 % · осталось ≈ 2x мин", /ролик 2 из 3 · 43 % · осталось ≈ 2\d мин/.test(bar), bar);
  check("плашка переливается, пока идёт", await page.locator(".ar-bar .ar-prog.ui-shim").count() === 1, null);
  const line = await text(page.locator(".tp-agent").first());
  check("строка блока: ролик 2 из 3 и 43 %", /разведывает · ролик 2 из 3 · 43 % · осталось ≈ \d+ мин/.test(line), line);
  check("полоса блока переливается", await page.locator(".tp-agent .tp-agent-bar.ui-shim").count() === 1, null);

  // --- идёт: ролики ---------------------------------------------------------- //
  const r0 = await text(row(0).locator(".tp-reel-ag")), r1 = await text(row(1).locator(".tp-reel-ag")), r2 = await text(row(2).locator(".tp-reel-ag"));
  check("первый — разведан", r0 === "разведан", r0);
  check("второй — 640 / 1 798 · 35 % · осталось ≈ 1x мин", /агент разведывает\s*640 \/ 1 798 · 35 % · осталось ≈ 1\d мин/.test(r1), r1);
  check("третий — 1-й в очереди, начнётся ≈ через 1x мин", /^в очереди агента · 1-й · начнётся ≈ через 1\d мин$/.test(r2), r2);
  // Начнётся у третьего = остаток второго: числа обязаны совпасть
  check("«начнётся» третьего = «осталось» второго", r2.match(/через (\d+)/)?.[1] === r1.match(/≈ (\d+)/)?.[1], [r1, r2]);
  const ag = row(1).locator(".tp-reel-ag");
  const fits = await ag.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().height <= 24);
  check("строка идущего ролика в одну строку, не вылезает", fits, await ag.boundingBox());
  await page.screenshot({ path: `${OUT}/progress-running.png`, fullPage: true });

  // Прогноз очереди держится до смены ролика: два опроса — тот же текст
  await page.waitForTimeout(4500);
  check("«начнётся» не дёргается на опросе", await text(row(2).locator(".tp-reel-ag")) === r2, await text(row(2).locator(".tp-reel-ag")));

  // --- меню ролика: пункты погашены с причиной ------------------------------ //
  await row(2).getByRole("button", { name: `Ещё: ${videos[2].file_name}` }).click();
  const item = page.locator(".ui-opt", { hasText: "Разметить нарезанные кадры ролика" });
  await item.waitFor({ timeout: 5000 }).catch(() => null);
  check("новый пункт есть и погашен", await item.count() === 1 && await item.isDisabled(), await item.count());
  const why = await text(item.locator(".ui-opt-h"));
  check("причина — что идёт и сколько ждать", /^идёт разведка · осталось ≈ 2\d мин$/.test(why), why);
  await page.screenshot({ path: `${OUT}/progress-menu.png` });
  await page.keyboard.press("Escape");

  // --- доска: значок первым -------------------------------------------------- //
  await page.goto(`${BASE}/projects/${temp}/tasks`);
  const card = page.locator(".tb-card", { hasText: "Проба хода агента" });
  await card.locator(".tb-badges .ui-badge").first().waitFor({ timeout: 15000 }).catch(() => null);
  const badges = await card.locator(".tb-badges .ui-badge").allInnerTexts();
  check("доска: первыми — «агент разведывает» и «43 % · ≈ 2x мин»",
    badges[0]?.trim() === "агент разведывает" && /^43 % · ≈ 2\d мин$/.test(badges[1]?.trim() ?? ""), badges);
  // Узкая карточка (5 колонок) кладёт значки в два ряда — ни один из двух не должен уйти в многоточие
  const clipped = await card.locator(".tb-badges .ui-badge .t-ell").evaluateAll((els) => els.slice(0, 2).map((el) => el.scrollWidth > el.clientWidth + 1));
  check("оба значка агента целиком, без многоточия", clipped.length === 2 && !clipped.some(Boolean), clipped);
  await card.screenshot({ path: `${OUT}/progress-board.png` });

  // --- ждёт карту: стоит, очередь без времени -------------------------------- //
  putRun("waiting_gpu", DONE, [1, -1]);
  await page.goto(pageUrl);
  await page.locator(".ar-bar").waitFor({ timeout: 20000 });
  await row(2).locator(".tp-reel-ag").waitFor({ timeout: 10000 });
  check("ждёт карту: перелива нет", await page.locator(".ar-bar .ar-prog.ui-shim").count() === 0 && await page.locator(".tp-agent-bar.ui-shim").count() === 0, null);
  const w1 = await text(row(1).locator(".tp-reel-ag")), w2 = await text(row(2).locator(".tp-reel-ag"));
  check("ждёт карту: второй 1-й, третий 2-й, без времени", w1 === "в очереди агента · 1-й" && w2 === "в очереди агента · 2-й", [w1, w2]);
  check("ждёт карту: плашка без «осталось»", !/осталось|считаю/.test(await text(page.locator(".ar-bar"))), await text(page.locator(".ar-bar")));

  // --- первые кадры: «считаю время» ----------------------------------------- //
  sql("UPDATE agent_runs SET status = 'running', processed = 5, stats = %s::jsonb WHERE id = %s", [stats(null, 5, 3, 0), runId]);
  await page.goto(pageUrl);
  await page.locator(".ar-bar").waitFor({ timeout: 20000 });
  await row(0).locator(".tp-reel-ag").waitFor({ timeout: 10000 });
  const b0 = await text(page.locator(".ar-bar"));
  check("первые кадры: ролик 1 из 3 · 0 % · считаю время", /ролик 1 из 3 · 0 % · считаю время/.test(b0), b0);
  const s0 = await text(row(0).locator(".tp-reel-ag")), s1 = await text(row(1).locator(".tp-reel-ag"));
  check("первые кадры: ролик — считаю время, очередь — только место", /5 \/ 1 198 · 0 % · считаю время/.test(s0) && s1 === "в очереди агента · 1-й", [s0, s1]);
  await page.screenshot({ path: `${OUT}/progress-start.png` });

  // --- после прогона: нарезали — пункт ролика с числом новых ----------------- //
  sql("DELETE FROM agent_runs WHERE id = %s", [runId]);
  runId = null;
  const cut = await api("POST", `/api/tasks/${task.id}/videos/${videos[0].id}/cut`,
    { segments: [{ start_ms: 0, end_ms: 4000, step_ms: 1000 }] });
  for (let i = 0; i < 60; i++) {
    const job = await api("GET", `/api/jobs/${cut.job_id}`).catch(() => null);
    if (job && (job.status === "done" || job.status === "error")) break;
    await page.waitForTimeout(1000);
  }
  await page.goto(pageUrl);
  await row(0).waitFor({ timeout: 20000 });
  check("после прогона строк агента нет", await page.locator(".tp-reel-ag").count() === 0, await page.locator(".tp-reel-ag").count());
  await row(0).getByRole("button", { name: `Ещё: ${videos[0].file_name}` }).click();
  const one = page.locator(".ui-opt", { hasText: "Разметить нарезанные кадры ролика" });
  await one.waitFor({ timeout: 5000 }).catch(() => null);
  const hint = await text(one.locator(".ui-opt-h"));
  // У временного проекта агент мог остаться выбранным, а классы — нет: тогда причина про них, иначе «N новых»
  check("пункт ролика: «4 новых» или причина про агента/классы", /^4 новых$|^выберите агента ⚙$|^классы не сопоставлены ⚙$/.test(hint), hint);
  await page.screenshot({ path: `${OUT}/progress-cut-menu.png` });
} finally {
  if (runId) sql("DELETE FROM agent_runs WHERE id = %s", [runId]);
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  for (const [ok, what, got] of checks) console.log(ok, what, "—", typeof got === "string" ? got : JSON.stringify(got));
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
