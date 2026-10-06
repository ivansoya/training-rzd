/** Проба редизайна: редактор видео «Дорожки снизу» глазами браузера.
 *  По умолчанию только смотрит ролик tester в РСМ-2000. TRACKS=1 — временный проект с треками, в конце удаляется.
 *  BASE — через проброс на localhost (forward.mjs): WebCodecs живёт только в защищённом контексте. */
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5174";
const OUT = "/work/tests/e2e/test-results";
const PROJECT = process.env.PROJECT || "РСМ-2000";
const TRACKS = process.env.TRACKS === "1";
// Настоящий Chrome из образа: только он разжимает H.264
const browser = await chromium.launch(existsSync("/opt/google/chrome/chrome") ? { channel: "chrome" } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/401/.test(m.text()) && errors.push(m.text()));

await page.goto(BASE + "/");
console.log("вход:", await page.evaluate(async () => (await fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
})).status));

const api = async (method, url, data) => {
  const r = await page.request.fetch(BASE + url, { method, data });
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? null : r.json();
};

let temp = null;
let at = null;
try {
  if (TRACKS) {
    // Временный проект: ролик на 300 кадров, два трека, одиночные, фоновые
    const proj = await api("POST", "/api/projects", { name: `test-video-${Date.now() % 100000}` });
    temp = proj.code;
    await api("POST", `/api/projects/${temp}/classes`, { name: "вагон" });
    await api("POST", `/api/projects/${temp}/classes`, { name: "человек" });
    const task = await api("POST", `/api/projects/${temp}/tasks`, { name: "Проба видео" });
    await api("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
    const up = await page.request.post(`${BASE}/api/tasks/${task.id}/videos`, {
      multipart: {
        file: { name: "perehod.mp4", mimeType: "video/mp4", buffer: readFileSync("/tmp/magistral-sample-300f.mp4") },
        mode: "annotate",
      },
    });
    const video = await up.json();
    const cls = (await api("GET", `/api/projects/${temp}/classes`)).classes;
    const [a, b] = cls.map((c) => c.class_index);
    const t1 = await api("POST", `/api/tasks/${task.id}/videos/${video.id}/tracks`,
      { class_index: a, frame_no: 20, geometry: { x: 40, y: 120, w: 80, h: 60 } });
    await api("PUT", `/api/video-tracks/${t1.id}/keys/90`, { geometry: { x: 140, y: 110, w: 90, h: 64 } });
    await api("PUT", `/api/video-tracks/${t1.id}/keys/160`, { geometry: { x: 220, y: 100, w: 80, h: 60 } });
    await api("POST", `/api/video-tracks/${t1.id}/hide`, { from: 110, to: 130 });
    const t2 = await api("POST", `/api/tasks/${task.id}/videos/${video.id}/tracks`,
      { class_index: b, frame_no: 60, geometry: { x: 200, y: 140, w: 30, h: 70 } });
    await api("PUT", `/api/video-tracks/${t2.id}/keys/240`, { geometry: { x: 60, y: 150, w: 30, h: 70 } });
    for (const f of [8, 200, 205]) {
      await api("PUT", `/api/tasks/${task.id}/videos/${video.id}/frames/${f}/boxes`,
        { boxes: [{ class_index: b, x: 150, y: 60, w: 40, h: 40 }] });
    }
    for (const f of [270, 280]) await api("PUT", `/api/tasks/${task.id}/videos/${video.id}/empty-frames/${f}`, {});
    at = { code: temp, task: task.id, video: "perehod.mp4" };
  } else {
    at = await page.evaluate(async (name) => {
      const r = await (await fetch("/api/projects")).json();
      const code = (r.projects.find((p) => p.name === name) || r.projects[0]).code;
      const tasks = await (await fetch(`/api/projects/${code}/tasks`)).json();
      for (const t of tasks.tasks || tasks) {
        const full = await (await fetch(`/api/tasks/${t.id}`)).json();
        const v = (full.videos || []).find((x) => x.mode === "annotate");
        if (v) return { code, task: t.id, video: v.file_name };
      }
      return null;
    }, PROJECT);
  }
  console.log("ролик:", at);
  if (!at) throw new Error("ролика нет");

  await page.goto(`${BASE}/projects/${at.code}/tasks/${at.task}`);
  const open = page.locator(".tp-vid", { hasText: at.video }).getByRole("button", { name: /Размечать ролик|Смотреть/ });
  await open.waitFor({ timeout: 20000 });
  await page.waitForFunction(() => ![...document.querySelectorAll(".tp-vid button")].some((b) => b.textContent?.includes("Размечать") && b.disabled), null, { timeout: 60000 }).catch(() => {});
  await open.click();
  const ed = page.getByRole("dialog", { name: "Разметка видео" });
  await ed.waitFor({ timeout: 20000 });
  await ed.locator(".ve-busy").waitFor({ state: "detached", timeout: 30000 }).catch(() => console.log("кадр не показался"));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/ve-main.png` });

  if (TRACKS) {
    // Трек с дорожки: выбор, ручки, переход к его жизни
    await ed.locator(".ve-r[data-track-id] .ve-n-b").first().click();
    await page.waitForTimeout(400);
    await ed.locator(".ve-r[data-track-id] .ve-l").first().click({ position: { x: 340, y: 15 } });
    await ed.locator(".ve-busy").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
    const row = ed.locator(".ve-side .fe-obj-r").first();
    if (await row.count() && !(await ed.locator(".ve-side .fe-obj.on").count())) await row.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/ve-track.png` });
    await ed.locator(".ve-side").screenshot({ path: `${OUT}/ve-side.png` });
    // Меню ромба
    const key = ed.locator(".ve-kf").nth(1);
    const kb = await key.boundingBox();
    if (kb) {
      await page.mouse.click(kb.x + kb.width / 2, kb.y + kb.height / 2, { button: "right" });
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${OUT}/ve-lanemenu.png` });
      await page.keyboard.press("Escape");
    }
  } else {
    const tick = ed.locator(".ve-tick-s").first();
    if (await tick.count()) {
      await tick.dispatchEvent("pointerdown", { button: 0 });
      await page.waitForTimeout(2500);
      const row = ed.locator(".fe-obj-r").first();
      if (await row.count()) { await row.click(); await page.waitForTimeout(400); }
      await page.screenshot({ path: `${OUT}/ve-single.png` });
    }
  }

  await ed.locator(".ve-dock").screenshot({ path: `${OUT}/ve-dock.png` });

  if (await ed.getByRole("button", { name: /^Разведка/ }).count()) {
    await page.keyboard.press("r");
    await page.waitForTimeout(400);
    await ed.locator(".ve-dock").screenshot({ path: `${OUT}/ve-scout.png` });
    await page.keyboard.press("r");
  }

  await ed.getByRole("combobox", { name: "Качество" }).click().catch(() => {});
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/ve-quality.png` });
  await page.keyboard.press("Escape");
  await ed.locator(".ed-tool-more").first().click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/ve-sam.png` });
  await page.keyboard.press("Escape");

  await page.keyboard.press("?");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/ve-keys.png` });
  await page.keyboard.press("Escape");

  if (TRACKS) {
    await ed.getByRole("button", { name: "Закрыть разметку" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/ve-close.png` });
    await page.keyboard.press("Escape");
  }
} finally {
  if (temp) console.log("проект удалён:", (await page.request.delete(`${BASE}/api/projects/${temp}`)).status());
  console.log("ошибки:", errors.length ? errors : "нет");
  await browser.close();
}
