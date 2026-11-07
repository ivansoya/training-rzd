import { expect, test } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { signIn, tag } from "../helpers";

// Opt-in: uses source routes beside the local stack, without restarting datasets.
test.skip(process.env.TEST_AGENT_REJECT_LOCAL !== "1", "Нужен локальный стек и TEST_AGENT_REJECT_LOCAL=1");
let server: ChildProcess;
test.beforeAll(() => {
  if (process.env.TEST_AGENT_REJECT_LOCAL !== "1") return;
  server = spawn("python3", ["-u", "-c", `
from flask import Flask
from common.web import register_json_errors
from datasets_svc.video_routes import bp
app = Flask(__name__)
register_json_errors(app)
app.register_blueprint(bp)
app.run(host='127.0.0.1', port=5011)
`], { stdio: "ignore" });
});
test.afterAll(() => server?.kill());

test("reject a video section for one agent, preserve neighbors and reviewed objects", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  await page.request.post(`/api/projects/${project.code}/classes`, { data: { name: "Объект" } });
  const task = await (await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });
  const path = execFileSync("python3", ["-c", "from sample import ensure; print(ensure())"]).toString().trim();
  const uploaded = await page.request.post(`/api/tasks/${task.id}/videos`, { multipart: {
    file: { name: "reject-section.mp4", mimeType: "video/mp4", buffer: readFileSync(path) }, mode: "annotate",
  } });
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  const video = await uploaded.json();
  const api = `/api/tasks/${task.id}/videos/${video.id}`;
  for (const f of [3, 5, 7, 10, 11]) {
    const xs = f === 7 ? [10, 60, 120, 160] : [10, 60];
    const response = await page.request.put(`${api}/frames/${f}/boxes`, { data: {
      boxes: xs.map((x) => ({ class_index: 0, x, y: 20, w: 30, h: 40 })),
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  execFileSync("python3", ["-c", `
import sys, uuid
from sqlalchemy import select
from common.db import SessionLocal
from common.models import AugGraph, AugGraphVersion, Task, TaskVideo, VideoAnnotation
db = SessionLocal()
video = db.get(TaskVideo, uuid.UUID(sys.argv[1]))
task = db.get(Task, video.task_id)
versions = []
for name in ['Первый агент', 'Второй агент']:
    graph = AugGraph(name=name, kind='agent')
    db.add(graph); db.flush()
    version = AugGraphVersion(graph_id=graph.id, version=1, digest=uuid.uuid4().hex, doc={})
    db.add(version); db.flush(); versions.append(version.id)
for row in db.execute(select(VideoAnnotation).where(VideoAnnotation.video_id == video.id)).scalars():
    x = row.geometry['x']
    if x in (10, 60, 160):
        row.source = 'model'; row.pending = x != 160
        row.agent_version_id = versions[1 if x == 60 else 0]
db.commit()
`, video.id]);
  await page.route(`**${api}/agent-reject`, async (route) => {
    const response = await route.fetch({ url: `http://127.0.0.1:5011${api}/agent-reject`, headers: route.request().headers() });
    await route.fulfill({ response });
  });
  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  await page.getByRole("button", { name: "Размечать ролик" }).click();
  const editor = page.getByRole("dialog", { name: "Разметка видео", exact: true });
  const open = editor.getByRole("button", { name: "Отклонить на участке…" });
  await expect(open).toBeEnabled({ timeout: 60000 });
  await expect(open).toHaveText("");
  for (const arrow of await editor.locator(".ed-review-go").all()) {
    expect((await arrow.boundingBox())!.width).toBe(26);
  }
  const nav = await editor.locator(".ed-review-nav").evaluate((el) => {
    const caption = el.querySelector(".ed-review-t")!.getBoundingClientRect();
    const next = el.querySelectorAll("button")[1].getBoundingClientRect();
    return next.left - caption.right;
  });
  expect(nav).toBeLessThanOrEqual(8);
  expect((await editor.locator(".ed-review").boundingBox())!.width).toBeLessThan(760);
  const annotations = async () => (await (await page.request.get(`${api}/annotations`)).json()).singles;
  const before = await annotations();
  expect(before).toHaveLength(12);

  await open.click();
  await expect(page.getByRole("dialog", { name: "Отклонить на участке", exact: true })).toHaveCount(0);
  const dialog = editor.getByRole("group", { name: "Отклонение на участке" });
  const timeline = editor.getByLabel("Выделение участка на дорожке агента");
  const rect = (await timeline.boundingBox())!;
  await page.mouse.move(rect.x + rect.width * .15, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * .35, rect.y + rect.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".ve-reject-selection")).toBeAttached();
  const endHandle = editor.getByRole("slider", { name: "Конец участка", exact: true });
  const endRect = (await endHandle.boundingBox())!;
  const beforeResize = await dialog.getByLabel("До кадра включительно").inputValue();
  await page.mouse.move(endRect.x + endRect.width / 2, endRect.y + endRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(endRect.x + 65, endRect.y + endRect.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(dialog.getByLabel("До кадра включительно")).not.toHaveValue(beforeResize);
  await dialog.getByLabel("До кадра включительно").fill("10");
  await dialog.getByLabel("От кадра", { exact: true }).fill("12");
  await dialog.getByLabel("От кадра", { exact: true }).blur();
  await expect(dialog.getByRole("status")).toContainText("раньше начала");
  await expect(dialog.getByRole("button", { name: /^Отклонить/ })).toBeDisabled();
  await dialog.getByLabel("От кадра", { exact: true }).fill("5");
  await dialog.getByLabel("До кадра включительно").fill("10");
  await dialog.getByLabel("До кадра включительно").blur();
  await expect(dialog.getByRole("status")).toContainText("6 объектов");
  await expect(dialog.getByRole("status")).toContainText("3 кадрах");
  await dialog.getByRole("combobox", { name: "Агент на участке" }).click();
  await page.getByRole("option", { name: "Первый агент", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("3 объекта");
  await dialog.getByLabel("От кадра", { exact: true }).fill("20");
  await dialog.getByLabel("До кадра включительно").fill("25");
  await dialog.getByLabel("До кадра включительно").blur();
  await expect(dialog.getByRole("status")).toContainText("Нет непроверенных");
  await expect(dialog.getByRole("combobox", { name: "Агент на участке" })).toContainText("Первый агент");
  await expect(dialog.getByRole("button", { name: /^Отклонить/ })).toBeDisabled();
  await dialog.getByLabel("От кадра", { exact: true }).fill("5");
  await dialog.getByLabel("До кадра включительно").fill("10");
  await dialog.getByLabel("До кадра включительно").blur();
  await expect(dialog.getByRole("status")).toContainText("3 объекта");
  await editor.getByRole("slider", { name: "Начало участка", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByLabel("От кадра", { exact: true })).toHaveValue("6");
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByLabel("От кадра", { exact: true })).toHaveValue("5");
  await expect(dialog.getByRole("status")).toContainText("3 объекта");
  for (const width of [1095, 1366]) {
    await page.setViewportSize({ width, height: 768 });
    expect(await editor.locator(".ve-dock").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await editor.screenshot({ path: test.info().outputPath(`reject-range-${width}.png`) });
  }
  await dialog.getByRole("button", { name: "Отменить выбор участка", exact: true }).click();
  expect(await annotations()).toEqual(before);

  await open.click();
  await dialog.getByLabel("От кадра", { exact: true }).fill("5");
  await dialog.getByLabel("До кадра включительно").fill("10");
  await dialog.getByLabel("До кадра включительно").blur();
  await expect(dialog.getByRole("status")).toContainText("6 объектов");
  await dialog.getByRole("combobox", { name: "Агент на участке" }).click();
  await page.getByRole("option", { name: "Первый агент", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("3 объекта");
  await dialog.getByRole("button", { name: "Отклонить", exact: true }).click();
  await expect(dialog).toBeHidden();
  const after = await annotations();
  expect(after).toHaveLength(9);
  expect(after.filter((b: any) => b.pending && b.agent?.name === "Первый агент").map((b: any) => b.frame_no).sort((a: number, b: number) => a - b)).toEqual([3, 11]);
  expect(after.filter((b: any) => b.pending && b.agent?.name === "Второй агент")).toHaveLength(5);
  expect(after.filter((b: any) => !b.pending)).toHaveLength(2);
  expect(errors).toEqual([]);
});
