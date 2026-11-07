// Реальные сохранения в локальный тестовый стек; серверу Voran тест не нужен.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.env.BASE || "http://localhost:5173";
const mailpit = process.env.MAILPIT || "http://mailpit:8025";
const browser = await chromium.launch({ channel: "chrome", args: [`--unsafely-treat-insecure-origin-as-secure=${base}`] });
const page = await browser.newPage();
page.on("pageerror", (error) => console.error("PAGE ERROR:", error.message));
const name = `test-keys-${Date.now()}`;
const email = `${name}@example.test`;
const password = "Test-Passw0rd";
const check = (ok, message) => { if (!ok) throw new Error(message); };
const json = async (r) => { check(r.ok(), `HTTP ${r.status()}: ${await r.text()}`); return r.json(); };
const sql = (statement, id) => execFileSync("python3", ["-c", `
import os, psycopg2, sys
c = psycopg2.connect(os.environ.get('TEST_DB_DSN', 'postgresql://app:app@db:5432/app'))
with c, c.cursor() as cur: cur.execute(sys.argv[1], (sys.argv[2],))
`, statement, id]);
const waitFor = async (fn, message, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(message);
};
const box = (x) => ({ class_index: 0, x, y: 20, w: 40, h: 50 });
try {
  await json(await page.request.post(`${base}/api/auth/register`, { data: { email, login: name, display_name: name, password } }));
  let link;
  await waitFor(async () => {
    const messages = await json(await page.request.get(`${mailpit}/api/v1/search?query=${encodeURIComponent(email)}`));
    if (!messages.messages?.length) return false;
    const mail = await json(await page.request.get(`${mailpit}/api/v1/message/${messages.messages[0].ID}`));
    link = mail.Text.match(/https?:\/\/\S*\/confirm\/[A-Za-z0-9_-]+/)?.[0];
    return !!link;
  }, "confirmation email missing");
  await page.goto(base + new URL(link).pathname);
  await page.getByText("Почта подтверждена").waitFor();
  await json(await page.request.post(`${base}/api/auth/login`, { data: { identity: name, password } }));
  const project = await json(await page.request.post(`${base}/api/projects`, { data: { name } }));
  await json(await page.request.post(`${base}/api/projects/${project.code}/classes`, { data: { name: "Объект" } }));
  const task = await json(await page.request.post(`${base}/api/projects/${project.code}/tasks`, { data: { name } }));
  await json(await page.request.post(`${base}/api/tasks/${task.id}/status`, { data: { status: "in_progress" } }));

  const jpeg = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 240;
    return c.toDataURL("image/jpeg").split(",")[1];
  });
  await json(await page.request.post(`${base}/api/tasks/${task.id}/images`, { multipart: {
    files: { name: "frame.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg, "base64") },
  } }));
  const images = await json(await page.request.get(`${base}/api/tasks/${task.id}/images?limit=10`));
  const image = images.images[0];
  await json(await page.request.put(`${base}/api/images/${image.id}/annotations`, { data: { boxes: [box(10), box(60), box(120)] } }));
  sql("update annotations set pending=true, source='model' where image_id=%s and (geometry->>'x')::numeric < 100", image.id);

  await page.goto(`${base}/projects/${project.code}/tasks/${task.id}?frame=${image.id}`);
  const frame = page.getByRole("dialog", { name: "Разметка кадров" });
  await frame.locator(".mag-cv-sh.pending").first().waitFor();
  await waitFor(async () => await frame.locator(".mag-cv-sh.pending:not(.mag-cv-ov)").count() === 2,
    "expected two pending objects in frame");
  await frame.getByRole("button", { name: /^Клавиши/ }).click();
  const keys = page.getByRole("dialog", { name: "Клавиши" });
  await keys.getByText("Отклонить все непроверенные объекты агентов на этом кадре").waitFor();
  await keys.getByText(/при рисовании — последнюю точку/).waitFor();
  await page.keyboard.press("Shift+Enter");
  check((await json(await page.request.get(`${base}/api/tasks/${task.id}/images?limit=10`))).images[0].boxes.length === 3,
    "shortcut fired in help dialog");
  await page.keyboard.press("Escape");
  await frame.evaluate((root) => {
    const input = document.createElement("input"); input.id = "shortcut-test-input";
    root.append(input); input.focus();
  });
  await page.keyboard.press("Shift+Enter");
  await page.evaluate(() => document.getElementById("shortcut-test-input").remove());
  check(await frame.locator(".mag-cv-sh.pending:not(.mag-cv-ov)").count() === 2, "shortcut fired while typing");
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", {
    code: "Enter", key: "Enter", shiftKey: true, repeat: true, bubbles: true,
  })));
  check(await frame.locator(".mag-cv-sh.pending:not(.mag-cv-ov)").count() === 2, "repeated key rejected another frame");
  await page.keyboard.press("p");
  const picture = await frame.locator(".mag-cv-frame").boundingBox();
  await page.mouse.click(picture.x + picture.width * 0.85, picture.y + picture.height * 0.8);
  await frame.locator(".mag-cv-draft").waitFor();
  await page.keyboard.press("Shift+Enter");
  check(await frame.locator(".mag-cv-draft").count() === 1, "shortcut closed a draft polygon");
  check(await frame.locator(".mag-cv-sh.pending:not(.mag-cv-ov)").count() === 2, "shortcut rejected during drawing");
  await frame.evaluate((root) => {
    const input = document.createElement("textarea"); input.id = "shortcut-test-input";
    root.append(input); input.focus();
  });
  await page.keyboard.press("Shift+Enter");
  check(await frame.locator("#shortcut-test-input").inputValue() === "\n", "shortcut blocked typing during a draft");
  await page.evaluate(() => document.getElementById("shortcut-test-input").remove());
  await page.keyboard.press("Escape");
  await frame.locator(".mag-cv-draft").waitFor({ state: "hidden" });
  await page.keyboard.press("Shift+Enter");
  await waitFor(async () => (await (await page.request.get(`${base}/api/tasks/${task.id}/images?limit=10`)).json()).images[0].boxes.length === 1,
    "frame rejection did not preserve just the human object");
  await frame.locator(".ed-save").getByText("Сохранено").waitFor();
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await (await page.request.get(`${base}/api/tasks/${task.id}/images?limit=10`)).json()).images[0].boxes.length === 3,
    "frame undo did not restore the agent objects");
  await frame.locator(".ed-save").getByText("Сохранено").waitFor();
  const frameTrash = frame.locator(".fe-obj:not(.pending) .fe-obj-delete");
  check(await frameTrash.count() === 1, "frame trash missing on unselected object");
  await frameTrash.focus();
  await page.keyboard.press("Enter");
  await waitFor(async () => {
    const boxes = (await json(await page.request.get(`${base}/api/tasks/${task.id}/images?limit=10`))).images[0].boxes;
    return boxes.length === 2 && boxes.every((b) => b.pending);
  }, "frame trash did not remove only the chosen human object");
  await frame.locator(".ed-save").getByText("Сохранено").waitFor();
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await json(await page.request.get(`${base}/api/tasks/${task.id}/images?limit=10`))).images[0].boxes.length === 3,
    "frame trash undo failed");
  console.log("PASS: кадр — справка, диалог, ввод, повтор, контур, отклонение и отмена");

  if (!process.env.FRAME_ONLY) {
  await page.goto(`${base}/projects/${project.code}/tasks/${task.id}`);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=10:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "/tmp/agent-keys.mp4"]);
  const video = await json(await page.request.post(`${base}/api/tasks/${task.id}/videos`, { multipart: {
    file: { name: "agent-keys.mp4", mimeType: "video/mp4", buffer: readFileSync("/tmp/agent-keys.mp4") }, mode: "annotate",
  } }));
  await waitFor(async () => {
    const t = await json(await page.request.get(`${base}/api/tasks/${task.id}`));
    return t.videos.find((v) => v.id === video.id)?.frame_count > 0;
  }, "video was not prepared", 90000);
  const videoBase = `${base}/api/tasks/${task.id}/videos/${video.id}`;
  await json(await page.request.put(`${videoBase}/frames/0/boxes`, { data: { boxes: [box(10), box(60), box(120)] } }));
  await json(await page.request.post(`${videoBase}/tracks`, { data: {
    class_index: 0, frame_no: 0, geometry: box(180),
  } }));
  sql("update video_annotations set pending=true, source='model' where video_id=%s and (geometry->>'x')::numeric < 100", video.id);
  const videoSkeleton = await json(await page.request.get(`${videoBase}/annotations?singles=0`, { timeout: 90000 }));
  check(videoSkeleton.marks?.some(([frame, n, pending]) => frame === 0 && n === 3 && pending === 2),
    `unexpected video marks: ${JSON.stringify(videoSkeleton.marks)}`);
  await page.goto(`${base}/projects/${project.code}/tasks/${task.id}`);
  await page.locator(".tp-vid").getByRole("button", { name: "Размечать ролик" }).click();
  const editor = page.getByRole("dialog", { name: "Разметка видео" });
  await editor.locator(".mag-cv-sh.pending").first().waitFor({ timeout: 90000 });
  await editor.getByRole("button", { name: /^Клавиши/ }).click();
  await keys.getByText("Отклонить все непроверенные объекты агентов на этом кадре").waitFor();
  await keys.getByText(/первый или последний кадр/).waitFor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+Enter");
  await waitFor(async () => (await json(await page.request.get(`${videoBase}/annotations`))).singles.filter((s) => s.frame_no === 0).length === 1,
    "video rejection did not preserve just the human object");
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await json(await page.request.get(`${videoBase}/annotations`))).singles.filter((s) => s.frame_no === 0).length === 3,
    "video undo did not restore the agent objects");
  const videoTrash = editor.locator(".fe-obj:not(.pending) .fe-obj-delete[aria-label='Удалить объект']");
  check(await videoTrash.count() === 1, "video trash missing on the human object");
  await videoTrash.click();
  await waitFor(async () => {
    const singles = (await json(await page.request.get(`${videoBase}/annotations`))).singles.filter((s) => s.frame_no === 0);
    return singles.length === 2 && singles.every((s) => s.pending);
  }, "video trash did not remove only the chosen human object");
  await editor.locator(".fe-obj-delete[aria-label='Удалить трек']").first().click();
  const confirmation = page.getByRole("dialog", { name: /^Удалить трек/ });
  await confirmation.getByRole("button", { name: "Отмена" }).click();
  check((await json(await page.request.get(`${videoBase}/annotations`))).tracks.length === 1,
    "cancelled track deletion removed the track");
  console.log("PASS: корзина кадров и видео, клавиатура и подтверждение удаления трека");
  console.log("PASS: видео — справка, отклонение только агента и отмена");
  }
} finally {
  await browser.close();
}
