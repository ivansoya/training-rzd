// Доска и обзор открыты во время сдачи, начатой в другой вкладке тем же пользователем.
// Без живых событий обе страницы должны узнать об окончании по работе.
import { chromium, expect } from "@playwright/test";

const base = process.env.BASE || "http://localhost:5173";
const mailpit = process.env.MAILPIT || "http://mailpit:8025";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const name = `test-handover-${Date.now()}`;
const password = "Test-Passw0rd";
const email = `${name}@example.test`;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const json = async (response) => {
  check(response.ok(), `HTTP ${response.status()}: ${await response.text()}`);
  return response.json();
};
try {
  await json(await page.request.post(`${base}/api/auth/register`, { data: { email, login: name, display_name: name, password } }));
  let link;
  for (let i = 0; i < 30 && !link; i++) {
    const messages = await json(await page.request.get(`${mailpit}/api/v1/search?query=${encodeURIComponent(email)}`));
    if (messages.messages?.length) {
      const mail = await json(await page.request.get(`${mailpit}/api/v1/message/${messages.messages[0].ID}`));
      link = mail.Text.match(/https?:\/\/\S*\/confirm\/[A-Za-z0-9_-]+/)?.[0];
    }
    if (!link) await new Promise((r) => setTimeout(r, 250));
  }
  check(link, "confirmation email missing");
  await page.goto(base + new URL(link).pathname);
  await page.getByText("Почта подтверждена").waitFor();
  await json(await page.request.post(`${base}/api/auth/login`, { data: { identity: name, password } }));
  const project = await json(await page.request.post(`${base}/api/projects`, { data: { name } }));
  const task = await json(await page.request.post(`${base}/api/projects/${project.code}/tasks`, { data: { name } }));
  await json(await page.request.post(`${base}/api/tasks/${task.id}/status`, { data: { status: "in_progress" } }));

  let done = false;
  await context.route(`**/api/projects/${project.code}`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.datasets = [{ id: "test-dataset", name: "test-dataset" }];
    await route.fulfill({ response, json: data });
  });
  await context.route(`**/api/projects/${project.code}/tasks`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.tasks = data.tasks.map((t) => t.id === task.id
      ? { ...t, status: done ? "done" : "updating", handover: done ? null : "test-handover-job" } : t);
    await route.fulfill({ response, json: data });
  });
  await context.route(`**/api/tasks/${task.id}/summary`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.handover = done ? null : "test-handover-job";
    await route.fulfill({ response, json: data });
  });
  await context.route(`**/api/tasks/${task.id}`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.status = done ? "done" : "updating";
    data.handover = done ? null : "test-handover-job";
    await route.fulfill({ response, json: data });
  });
  await context.route("**/api/jobs/test-handover-job", (route) => route.fulfill({ json: {
    id: "test-handover-job", status: done ? "done" : "running", result: done ? {} : null,
    total: 1, processed: done ? 1 : 0,
  } }));

  const overview = await context.newPage();
  const detail = await context.newPage();
  await Promise.all([page.goto(`${base}/projects/${project.code}/tasks`), overview.goto(`${base}/projects/${project.code}`),
    detail.goto(`${base}/projects/${project.code}/tasks/${task.id}`)]);
  const card = page.locator(".tb-card", { hasText: name });
  await card.getByText("сдаётся", { exact: true }).waitFor();
  await overview.locator(".ov-tasks li", { hasText: name }).locator('[title="Изменение"]').waitFor();
  await detail.locator(".tp-pass").getByText("Изменение", { exact: true }).waitFor();
  done = true;
  await page.getByRole("region", { name: "Готово" }).locator(".tb-card", { hasText: name }).waitFor({ timeout: 8000 });
  await overview.locator(".ov-tasks li", { hasText: name }).locator('[title="Готово"]').waitFor({ timeout: 8000 });
  await detail.locator(".tp-pass").getByText("Готово", { exact: true }).first().waitFor({ timeout: 8000 });
  await expect(card.getByText("сдаётся", { exact: true })).toHaveCount(0);
  console.log("PASS: доска, обзор проекта и страница таски обновились без события и перезагрузки");

  await json(await page.request.post(`${base}/api/projects/${project.code}/classes`, { data: { name: "Test class" } }));
  const imageBytes = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 240;
    return canvas.toDataURL("image/jpeg").split(",")[1];
  });
  await json(await page.request.post(`${base}/api/tasks/${task.id}/images`, { multipart: {
    files: { name: "frame.jpg", mimeType: "image/jpeg", buffer: Buffer.from(imageBytes, "base64") },
  } }));
  const images = await json(await page.request.get(`${base}/api/tasks/${task.id}/images?limit=10`));
  const image = images.images[0];
  await json(await page.request.put(`${base}/api/images/${image.id}/annotations`, { data: { boxes: [
    { class_index: 0, x: 10, y: 10, w: 80, h: 70 },
    { class_index: 0, x: 110, y: 10, w: 80, h: 70 },
    { class_index: 0, kind: "polygon", x: 10, y: 110, w: 80, h: 70,
      parts: [[[10, 110], [90, 110], [90, 180], [10, 180]]] },
    { class_index: 0, kind: "polygon", x: 110, y: 110, w: 80, h: 70,
      parts: [[[110, 110], [190, 110], [190, 180], [110, 180]]] },
  ] } }));
  let accepted = false;
  await context.route(`**/api/tasks/${task.id}/images?*`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    for (const frame of data.images ?? []) {
      frame.boxes = (frame.boxes ?? []).map((b, i) => i === 1 || i === 3
        ? { ...b, pending: !(accepted && i === 1), source: "model", agent: { name: "test", version: 1 } } : b);
    }
    await route.fulfill({ response, json: data });
  });
  await page.goto(`${base}/projects/${project.code}/tasks/${task.id}?frame=${image.id}`);
  const editor = page.getByRole("dialog", { name: "Разметка кадров" });
  await editor.locator(".mag-cv-sh.pending.poly .mag-cv-line").waitFor();
  const styles = await editor.evaluate((root) => {
    const style = (selector) => getComputedStyle(root.querySelector(selector));
    return {
      normalBox: style(".mag-cv-sh:not(.pending):not(.poly) .mag-cv-line").stroke,
      agentBox: style(".mag-cv-sh.pending:not(.poly) .mag-cv-line").stroke,
      normalCage: style(".mag-cv-sh.poly:not(.pending) .mag-cv-cage").stroke,
      agentCage: style(".mag-cv-sh.pending.poly .mag-cv-cage").stroke,
      marks: root.querySelectorAll('.mag-cv-lb [title="Разметил агент"]').length,
      overlays: root.querySelectorAll(".mag-cv-ov.pending").length,
    };
  });
  check(styles.normalBox === styles.agentBox && styles.normalCage === styles.agentCage, JSON.stringify(styles));
  check(styles.marks === 2 && styles.overlays === 0, JSON.stringify(styles));
  console.log("PASS: рамки и контуры агента имеют базовый цвет класса и значок агента");
  accepted = true;
  await page.reload();
  await editor.locator(".mag-cv-sh.pending .mag-cv-line").first().waitFor();
  check(await editor.locator('.mag-cv-lb [title="Разметил агент"]').count() === 2,
    "значок подтверждённой разметки агента пропал");
  console.log("PASS: после подтверждения значок авторства сохраняется");
} finally {
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await browser.close();
}
