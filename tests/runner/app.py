"""Тестовый сервис: гоняет все наборы и показывает результат страницей.

Четыре набора, четыре разных инструмента, один экран:

  единицы   pytest по чистой логике бэкенда — без базы и сервера;
  API       pytest против живого бэкенда, через тот же nginx, что и браузер;
  клиент    vitest по логике редактора;
  сквозные  Playwright: настоящий браузер ходит по интерфейсу.

Вывод читается построчно и сразу попадает на страницу: прогон видно по ходу, а
не только в конце. Каждый инструмент поэтому запускается подробным репортёром —
строка на тест, — и вторым, машиночитаемым, из которого потом собирается разбор.

Держим только последний результат каждого набора: история тут не нужна, нужен
ответ «сейчас зелено или нет».
"""
import json
import os
import re
import subprocess
import sys
import threading
import time

from flask import Flask, Response, jsonify

ROOT = "/work"
REPORT_DIR = "/tmp/reports"
# Сколько строк вывода держим. Хвоста хватает, чтобы понять причину падения,
# а полный лог упавшего Playwright — это мегабайты в каждом ответе /state.
KEEP_LINES = 600
RUN_TIMEOUT = 1800

SUITES = {
    "unit": {
        "title": "Единицы",
        "hint": "Интерполяция треков и план выгрузки. Ни базы, ни сервера.",
        "kind": "pytest",
        "cmd": ["python3", "-m", "pytest", f"{ROOT}/tests/unit", "-v", "--no-header",
                "--json-report", f"--json-report-file={REPORT_DIR}/unit.json"],
        "cwd": f"{ROOT}/tests",
    },
    "api": {
        "title": "API живого бэкенда",
        "hint": "Загрузка ролика, треки, сдача таски, кадры в проекте.",
        "kind": "pytest",
        "cmd": ["python3", "-m", "pytest", f"{ROOT}/tests/api", "-v", "--no-header",
                "--json-report", f"--json-report-file={REPORT_DIR}/api.json"],
        "cwd": f"{ROOT}/tests/api",
    },
    "load": {
        "title": "Нагрузка",
        "hint": "Отвечает ли API, пока воркер режет видео. Идёт после API-набора.",
        "kind": "pytest",
        "cmd": ["python3", "-m", "pytest", f"{ROOT}/tests/load", "-v", "--no-header",
                "--json-report", f"--json-report-file={REPORT_DIR}/load.json"],
        "cwd": f"{ROOT}/tests/load",
    },
    "client": {
        "title": "Клиент",
        "hint": "Расчёт положения объекта в редакторе — тот же, что на сервере.",
        "kind": "vitest",
        # Зависимости клиента ставятся при первом прогоне: node_modules с хоста
        # закрыты своим томом, потому что бинарники в них собраны под другую
        # платформу. Дальше том остаётся, и установка не повторяется.
        "cmd": ["bash", "-lc",
                "[ -x node_modules/.bin/vitest ] || npm install --no-audit --no-fund"
                " && npx vitest run --reporter=basic --reporter=json"
                f" --outputFile.json={REPORT_DIR}/client.json"],
        "cwd": f"{ROOT}/frontend",
    },
    "e2e": {
        "title": "Сквозные",
        "hint": "Браузер входит, открывает таску и размечает видео.",
        "kind": "playwright",
        # Пакет Playwright лежит в образе и раскатывается в свой том при первом
        # прогоне: глобальную установку ESM-резолвер Node не видит. Копируем
        # содержимое (`/.`) — каталог уже создан томом, и обычное `cp -r` вложило
        # бы копию внутрь него. Зовём локальный бинарник, а не npx: тот при
        # промахе молча тянет из сети свежую версию мимо браузеров образа.
        "cmd": ["bash", "-lc",
                "[ -d node_modules/@playwright/test ]"
                " || cp -r /opt/e2e/node_modules/. ./node_modules/;"
                " ./node_modules/.bin/playwright test --reporter=list,json"],
        "cwd": f"{ROOT}/tests/e2e",
        "report": f"{REPORT_DIR}/e2e.json",
    },
}

# Полоса выполнения у pytest есть своя — берём её, а не считаем сами.
PERCENT = re.compile(r"\[\s*(\d{1,3})%\]")
PASS_MARK = re.compile(r"\sPASSED\b|^\s*[✓√]\s")
FAIL_MARK = re.compile(r"\sFAILED\b|\sERROR\b|^\s*[✘✗×]\s")

app = Flask(__name__)
_lock = threading.Lock()
_state = {key: {"status": "idle"} for key in SUITES}


def _run(name):
    suite = SUITES[name]
    os.makedirs(REPORT_DIR, exist_ok=True)
    started = time.time()
    with _lock:
        _state[name] = {"status": "running", "started": started,
                        "passed": 0, "failed": 0, "percent": None, "output": ""}

    env = dict(os.environ)
    if suite["kind"] == "playwright":
        env["PLAYWRIGHT_JSON_OUTPUT_NAME"] = suite["report"]

    lines, passed, failed, percent = [], 0, 0, None
    try:
        proc = subprocess.Popen(
            suite["cmd"], cwd=suite["cwd"], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
    except Exception as exc:  # noqa: BLE001
        with _lock:
            _state[name] = {"status": "failed", "code": -1, "cases": [],
                            "seconds": 0, "output": f"Не удалось запустить набор: {exc}"}
        return

    deadline = started + RUN_TIMEOUT
    for line in proc.stdout:
        line = line.rstrip("\n")
        lines.append(line)
        if len(lines) > KEEP_LINES:
            del lines[0]
        if PASS_MARK.search(line):
            passed += 1
        elif FAIL_MARK.search(line):
            failed += 1
        found = PERCENT.search(line)
        if found:
            percent = int(found.group(1))
        # Страница опрашивает /state и показывает это по ходу прогона.
        with _lock:
            _state[name].update(output="\n".join(lines), passed=passed,
                                failed=failed, percent=percent)
        if time.time() > deadline:
            proc.kill()
            lines.append(f"Прогон не уложился в {RUN_TIMEOUT // 60} минут и прерван.")
            break

    code = proc.wait()
    # Сквозные тесты создают проекты и людей через браузер, а фикстур pytest у
    # них нет. Убираем за ними здесь, иначе обещание «всё стирается в конце
    # прогона» держалось бы только для половины наборов.
    if suite["kind"] == "playwright":
        _wipe_test_data()
    with _lock:
        _state[name] = {
            "status": "passed" if code == 0 else "failed",
            "code": code,
            "output": "\n".join(lines),
            "seconds": round(time.time() - started, 1),
            "passed": passed,
            "failed": failed,
            "percent": 100 if code == 0 else percent,
            "cases": _cases(name, suite),
            "finished": time.time(),
        }


def _wipe_test_data():
    """Стереть всё с меткой `test-`. Проекты уходят каскадом со всем содержимым."""
    try:
        import psycopg2

        dsn = os.environ.get("TEST_DB_DSN", "postgresql://app:app@db:5432/app")
        with psycopg2.connect(dsn) as conn:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("DELETE FROM projects WHERE name LIKE 'test-%%'")
                cur.execute("DELETE FROM users WHERE login LIKE 'test-%%'")
    except Exception as exc:  # noqa: BLE001
        print(f"Уборка после сквозных не удалась: {exc}")


def _cases(name, suite):
    """Разбор по тестам из машиночитаемого отчёта.

    Отчёт может не появиться — например, набор упал на импорте. Тогда на
    странице остаётся вывод команды, и этого достаточно, чтобы понять причину.
    """
    path = suite.get("report") or f"{REPORT_DIR}/{name}.json"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return []

    out = []
    if suite["kind"] == "pytest":
        for test in data.get("tests", []):
            # «test_ключевой_кадр…» — служебное имя функции. На странице оно
            # должно читаться как фраза, а не как идентификатор.
            title = test.get("nodeid", "").split("::")[-1]
            out.append({
                "name": title.removeprefix("test_").replace("_", " "),
                "status": test.get("outcome", "?"),
                "seconds": round(sum(
                    (test.get(phase) or {}).get("duration", 0)
                    for phase in ("setup", "call", "teardown")
                ), 2),
                "message": ((test.get("call") or {}).get("longrepr") or "")[-1200:],
            })
    elif suite["kind"] == "vitest":
        for file in data.get("testResults", []):
            for test in file.get("assertionResults", []):
                out.append({
                    "name": test.get("title", ""),
                    "status": "passed" if test.get("status") == "passed" else "failed",
                    "seconds": round((test.get("duration") or 0) / 1000, 2),
                    "message": "\n".join(test.get("failureMessages") or [])[-1200:],
                })
    else:  # playwright
        def walk(suites):
            for item in suites or []:
                for spec in item.get("specs", []):
                    tests = spec.get("tests") or [{}]
                    results = (tests[0].get("results") or [{}])[0]
                    out.append({
                        "name": spec.get("title", ""),
                        "status": "passed" if spec.get("ok") else "failed",
                        "seconds": round((results.get("duration") or 0) / 1000, 2),
                        "message": str(results.get("error", {}).get("message", ""))[-1200:],
                    })
                walk(item.get("suites"))
        walk(data.get("suites"))
    return out


@app.post("/run/<name>")
def run(name):
    if name == "all":
        # Наборы идут по очереди, а не разом: API и сквозные работают с одной
        # базой, и вперемешку они мешали бы друг другу.
        _start_chain(list(SUITES))
        return jsonify({"started": list(SUITES)})
    if name not in SUITES:
        return jsonify({"error": "Такого набора нет."}), 404
    _start_chain([name])
    return jsonify({"started": [name]})


def _start_chain(names):
    with _lock:
        if any(_state[n].get("status") == "running" for n in _state):
            return
        for n in names:
            _state[n] = {"status": "queued"}

    def worker():
        for n in names:
            _run(n)

    threading.Thread(target=worker, daemon=True).start()


@app.get("/state")
def state():
    with _lock:
        return jsonify({
            "suites": [
                {"key": key, "title": s["title"], "hint": s["hint"], **_state[key]}
                for key, s in SUITES.items()
            ]
        })


@app.get("/")
def index():
    return Response(PAGE, mimetype="text/html; charset=utf-8")


PAGE = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Тесты · Магистраль ML</title>
<style>
  :root {
    --ink: #23282e; --dim: #5d6873; --faint: #8a949d;
    --paper: #f4f5f6; --card: #fff; --rule: #e2e6e9;
    --red: #e21a1a; --green: #1a7f4b; --amber: #b8860b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink);
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 40px 20px 80px; }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
           border-bottom: 2px solid var(--ink); padding-bottom: 14px; }
  h1 { margin: 0; font-size: 26px; letter-spacing: -0.01em; }
  .sub { color: var(--dim); font-size: 14px; }
  .sp { flex: 1; }
  button { font: inherit; cursor: pointer; border-radius: 4px; }
  button:disabled { opacity: 0.45; cursor: default; }
  .go { background: var(--red); color: #fff; border: 1px solid var(--red);
        padding: 8px 16px; font-weight: 600; }
  .go:hover:not(:disabled) { background: #c81616; }
  .ghost { background: #fff; color: var(--ink); border: 1px solid var(--rule);
           padding: 6px 12px; }
  .ghost:hover:not(:disabled) { border-color: var(--faint); }
  .suite { background: var(--card); border: 1px solid var(--rule); border-radius: 5px;
           margin-top: 18px; overflow: hidden; }
  .suite.running { border-color: var(--amber); }
  .suite-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px;
                flex-wrap: wrap; }
  .suite-head h2 { margin: 0; font-size: 17px; }
  .hint { color: var(--dim); font-size: 13px; flex-basis: 100%; }
  .pill { font: 600 11px ui-monospace, Menlo, monospace; letter-spacing: 0.06em;
          text-transform: uppercase; padding: 3px 9px; border-radius: 999px;
          border: 1px solid; white-space: nowrap; }
  .idle    { color: var(--faint); border-color: var(--rule); }
  .queued  { color: var(--faint); border-color: var(--faint); }
  .running { color: var(--amber); border-color: var(--amber); }
  .passed  { color: var(--green); border-color: var(--green); }
  .failed  { color: var(--red);   border-color: var(--red); }
  .took { color: var(--faint); font: 12px ui-monospace, Menlo, monospace; }
  .cnt-ok { color: var(--green); font: 600 12px ui-monospace, Menlo, monospace; }
  .cnt-bad { color: var(--red); font: 600 12px ui-monospace, Menlo, monospace; }
  .bar { height: 3px; background: #eef0f2; }
  .bar i { display: block; height: 100%; background: var(--amber);
           transition: width 0.3s ease; }
  .suite.passed-b .bar i { background: var(--green); }
  .suite.failed-b .bar i { background: var(--red); }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 7px 16px; border-top: 1px solid #f0f2f4; font-size: 13.5px;
       vertical-align: top; }
  td.st { width: 1%; white-space: nowrap; font: 600 11px ui-monospace, Menlo, monospace; }
  td.sec { width: 1%; text-align: right; color: var(--faint);
           font: 12px ui-monospace, Menlo, monospace; }
  tr.bad td { background: #fff7f7; }
  pre { margin: 0; padding: 12px 16px; background: #14181c; color: #e8ecef;
        font: 12px/1.5 ui-monospace, Menlo, monospace; overflow-x: auto;
        white-space: pre-wrap; word-break: break-word; max-height: 340px; }
  pre.live { max-height: 260px; }
  details > summary { padding: 9px 16px; cursor: pointer; color: var(--dim);
                      font-size: 13px; border-top: 1px solid var(--rule); }
  .msg { color: var(--red); font: 12px/1.45 ui-monospace, Menlo, monospace;
         white-space: pre-wrap; margin-top: 5px; }
  .note { margin-top: 26px; color: var(--dim); font-size: 13px;
          border-left: 2px solid var(--red); padding-left: 14px; }
  code { font: 12.5px ui-monospace, Menlo, monospace; background: #eef0f2;
         padding: 1px 5px; border-radius: 3px; }
</style></head>
<body><div class="wrap">
  <header>
    <h1>Тесты</h1>
    <span class="sub">Магистраль ML · только для разработки</span>
    <span class="sp"></span>
    <button class="go" id="all" onclick="run('all')">Запустить всё</button>
  </header>
  <div id="list"></div>
  <p class="note">
    Тесты работают с тем же бэкендом и той же базой, что открыты у вас в браузере.
    Всё, что они создают, помечено префиксом <code>test-</code> и стирается в конце прогона.
    Наборы идут по очереди: API и сквозные делят базу и вперемешку мешали бы друг другу.
  </p>
</div>
<script>
const LABEL = { idle: "не запускался", queued: "в очереди", running: "идёт",
                passed: "прошёл", failed: "упал" };
let busy = false;

async function run(name) {
  await fetch("/run/" + name, { method: "POST" });
  poll();
}
function esc(s) {
  return (s || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function render(suites) {
  busy = suites.some(s => s.status === "running" || s.status === "queued");
  document.getElementById("all").disabled = busy;

  document.getElementById("list").innerHTML = suites.map(s => {
    const cases = s.cases || [];
    const bad = cases.filter(c => c.status !== "passed" && c.status !== "skipped").length;
    const live = s.status === "running";
    const rows = cases.map(c => `
      <tr class="${c.status === "passed" ? "" : "bad"}">
        <td class="st ${c.status === "passed" ? "passed" : "failed"}">${esc(c.status)}</td>
        <td>${esc(c.name)}${c.message ? `<div class="msg">${esc(c.message)}</div>` : ""}</td>
        <td class="sec">${c.seconds ?? ""}</td>
      </tr>`).join("");

    const counters = (s.passed || s.failed)
      ? `<span class="cnt-ok">✓ ${s.passed || 0}</span>` +
        (s.failed ? `<span class="cnt-bad">✗ ${s.failed}</span>` : "")
      : "";

    return `<section class="suite ${live ? "running" : ""} ${s.status}-b">
      <div class="suite-head">
        <h2>${esc(s.title)}</h2>
        <span class="pill ${s.status}">${LABEL[s.status] || s.status}</span>
        ${counters}
        ${cases.length ? `<span class="took">${cases.length - bad} из ${cases.length}</span>` : ""}
        ${s.seconds ? `<span class="took">${s.seconds} с</span>` : ""}
        <span class="sp"></span>
        <button class="ghost" onclick="run('${s.key}')" ${busy ? "disabled" : ""}>Запустить</button>
        <span class="hint">${esc(s.hint)}</span>
      </div>
      <div class="bar"><i style="width: ${s.percent || (live ? 3 : 0)}%"></i></div>
      ${live
        ? `<pre class="live" id="live-${s.key}">${esc(tail(s.output, 14))}</pre>`
        : rows ? `<table>${rows}</table>` : ""}
      ${!live && s.output
        ? `<details><summary>Вывод команды</summary><pre>${esc(s.output)}</pre></details>`
        : ""}
    </section>`;
  }).join("");

  // Живой вывод держим прокрученным вниз — смотрят на последнюю строку.
  suites.filter(s => s.status === "running").forEach(s => {
    const el = document.getElementById("live-" + s.key);
    if (el) el.scrollTop = el.scrollHeight;
  });
}
function tail(text, n) {
  const rows = (text || "").split("\\n");
  return rows.slice(-n).join("\\n");
}
async function poll() {
  const res = await fetch("/state");
  const data = await res.json();
  render(data.suites);
  if (busy) setTimeout(poll, 700);
}
poll();
</script></body></html>
"""


if __name__ == "__main__":
    os.makedirs(REPORT_DIR, exist_ok=True)
    # Ролик готовим заранее: он общий для API-тестов и сквозных, и генерировать
    # его посреди прогона значило бы засчитать эту секунду в первый же тест.
    try:
        sys.path.insert(0, f"{ROOT}/tests")
        import sample

        sample.ensure()
        # Длинный ролик нужен перегонам: в коротком все кадры умещаются в один.
        sample.ensure_long()
    except Exception as exc:  # noqa: BLE001
        print(f"Не удалось подготовить тестовый ролик: {exc}")
    app.run(host="0.0.0.0", port=8090, threaded=True)
