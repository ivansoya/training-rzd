import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { signIn, tag } from "../helpers";

const compound = {
  class_index: 0, kind: "polygon", x: 20, y: 30, w: 240, h: 180,
  parts: [
    [[20, 30], [100, 30], [100, 100], [20, 100]],
    [[180, 140], [260, 140], [260, 210], [180, 210]],
  ],
};

async function setup(page: Page) {
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  for (const name of ["Вагон", "Деталь"]) {
    const res = await page.request.post(`/api/projects/${project.code}/classes`, { data: { name } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const task = await (await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })).json();
  const res = await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return { project, task };
}

async function detach(editor: Locator) {
  await expect(editor.locator(".ed-top")).not.toHaveClass(/waiting/, { timeout: 30_000 });
  await editor.locator(".mag-cv-sh.poly .mag-cv-hit").nth(1).click({ button: "right" });
  const action = editor.page().getByRole("menuitem", { name: /Выделить контур в новый объект/ });
  await expect(action).toBeVisible();
  await action.click();
  await expect(editor.locator(".mag-cv-sh.poly:not(.mag-cv-ov)")).toHaveCount(2);
  await expect(editor.locator(".mag-cv-sh.poly .mag-cv-hit")).toHaveCount(2);
  await expect(editor.locator(".ed-save")).toContainText("Сохранено");
}

async function mergePolygons(editor: Locator) {
  const polygons = editor.locator(".mag-cv-sh.poly:not(.mag-cv-ov)");
  await expect(polygons).toHaveCount(2);
  await polygons.nth(0).locator(".mag-cv-hit").first().click();
  await polygons.nth(1).locator(".mag-cv-hit").first().click({ modifiers: ["Control"] });
  await expect(editor.locator(".mag-cv-sh.poly.on:not(.mag-cv-ov)")).toHaveCount(2);
  await polygons.nth(1).locator(".mag-cv-hit").first().click({ button: "right" });
  await editor.page().getByRole("menuitem", { name: "Объединить", exact: true }).click();
  await expect(polygons).toHaveCount(1);
  await expect(polygons.locator(".mag-cv-hit")).toHaveCount(2);
}

test("кадры: стрелки и клавиши пропускают пустые; контур отделяется, сохраняется и отменяется", async ({ page }) => {
  const { project, task } = await setup(page);
  const buffer = Buffer.from(await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = 320; cv.height = 240;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#526674"; ctx.fillRect(0, 0, 320, 240);
    return cv.toDataURL("image/jpeg").split(",")[1];
  }), "base64");
  for (let i = 1; i <= 3; i++) {
    const res = await page.request.post(`/api/tasks/${task.id}/images`, {
      multipart: { files: { name: `frame-${i}.jpg`, mimeType: "image/jpeg", buffer } },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const listing = async () => (await (await page.request.get(`/api/tasks/${task.id}/images?limit=10`)).json()).images;
  const images = (await listing()).sort((a: { file_name: string }, b: { file_name: string }) => a.file_name.localeCompare(b.file_name));
  for (const i of [0, 2]) {
    const res = await page.request.put(`/api/images/${images[i].id}/annotations`, { data: { boxes: [compound] } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  await page.goto(`/projects/${project.code}/tasks/${task.id}?frame=${images[0].id}`);
  const editor = page.getByRole("dialog", { name: "Разметка кадров" });
  const header = editor.locator(".ed-h");
  await expect(header).toContainText("frame-1.jpg");
  await editor.getByRole("button", { name: "Следующий размеченный кадр (])", exact: true }).click();
  await expect(header).toContainText("frame-3.jpg");
  await editor.getByRole("button", { name: "Предыдущий размеченный кадр ([)", exact: true }).click();
  await expect(header).toContainText("frame-1.jpg");
  await page.goto(`/projects/${project.code}/tasks/${task.id}?frame=${images[1].id}`);
  await expect(header).toContainText("frame-2.jpg");
  const emptyFrame = editor.locator(".ed-top").getByRole("button", { name: /Пусто/ });
  await expect(emptyFrame).toBeVisible();
  await expect(emptyFrame.locator(".ed-tool-k")).toHaveText("E");
  await expect(editor.locator(".ed-top").getByRole("button", { name: "Вопрос к кадру" }).locator(".ed-tool-k")).toHaveText("C");
  await expect(editor.locator(".ed-bot").getByRole("button", { name: /Вопрос/ })).toHaveCount(0);
  await emptyFrame.click();
  await expect.poll(async () => (await listing()).find((im: { id: string }) => im.id === images[1].id).task_status).toBe("empty");
  await page.goto(`/projects/${project.code}/tasks/${task.id}?frame=${images[1].id}`);
  await expect(emptyFrame).toHaveAttribute("aria-pressed", "true");
  await emptyFrame.click();
  await expect(emptyFrame).toHaveAttribute("aria-pressed", "false");
  await page.goto(`/projects/${project.code}/tasks/${task.id}?frame=${images[0].id}`);
  await expect(header).toContainText("frame-1.jpg");
  await page.keyboard.press("BracketLeft");
  await expect(header).toContainText("frame-3.jpg");
  await page.keyboard.press("BracketRight");
  await expect(header).toContainText("frame-1.jpg");

  await detach(editor);
  const boxes = async () => (await listing()).find((im: { id: string }) => im.id === images[0].id).boxes;
  await expect.poll(async () => (await boxes()).length).toBe(2);
  await mergePolygons(editor);
  await expect.poll(async () => (await boxes()).length).toBe(1);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).length).toBe(2);
  await editor.locator(".mag-cv-sh.poly:not(.mag-cv-ov) .mag-cv-hit").last().click();
  await page.keyboard.press("Digit2");
  await expect.poll(async () => (await boxes()).map((b: { class_index: number }) => b.class_index).sort()).toEqual([0, 1]);
  await editor.locator(".mag-cv-sh.poly:not(.mag-cv-ov) .mag-cv-hit").first().click({ modifiers: ["Control"] });
  await expect(editor.getByText("Объединять можно только полигоны одного класса.")).toBeVisible();
  await expect(editor.locator(".mag-cv-sh.poly.on:not(.mag-cv-ov)")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).map((b: { class_index: number }) => b.class_index)).toEqual([0, 0]);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).length).toBe(1);
  await expect(editor.locator(".mag-cv-sh.poly .mag-cv-hit")).toHaveCount(2);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await boxes()).length).toBe(2);
  await page.reload();
  await expect(editor.locator(".mag-cv-sh.poly:not(.mag-cv-ov)")).toHaveCount(2);
  await editor.locator(".ed-top").getByRole("button", { name: "Очистить кадр" }).click();
  await expect.poll(async () => (await boxes()).length).toBe(0);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).length).toBe(2);
  await editor.screenshot({ path: test.info().outputPath("frame-editor.png") });
});

test("видео: переход по одиночным и ключам; отделение контура при инструменте «Трек»", async ({ page }) => {
  const { project, task } = await setup(page);
  const uploaded = await page.request.post(`/api/tasks/${task.id}/videos`, {
    multipart: {
      file: { name: "navigation.mp4", mimeType: "video/mp4", buffer: readFileSync(process.env.TEST_SAMPLE_VIDEO || "/tmp/magistral-sample-30f.mp4") },
      mode: "annotate",
    },
  });
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  const video = await uploaded.json();
  const path = `/api/tasks/${task.id}/videos/${video.id}`;
  const geometry = { x: 5, y: 5, w: 10, h: 10 };
  const created = await page.request.post(`${path}/tracks`, { data: { class_index: 0, frame_no: 0, geometry } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const track = await created.json();
  const key = await page.request.put(`/api/video-tracks/${track.id}/keys/15`, { data: { geometry, extend: true } });
  expect(key.ok(), await key.text()).toBeTruthy();
  const hiddenCreated = await page.request.post(`${path}/tracks`, { data: { class_index: 0, frame_no: 0, geometry } });
  expect(hiddenCreated.ok(), await hiddenCreated.text()).toBeTruthy();
  const hiddenTrack = await hiddenCreated.json();
  expect((await page.request.put(`/api/video-tracks/${hiddenTrack.id}/keys/15`, { data: { geometry, extend: true } })).ok()).toBeTruthy();
  expect((await page.request.patch(`/api/video-tracks/${hiddenTrack.id}`, { data: { hidden_ranges: [[5, 12]] } })).ok()).toBeTruthy();
  for (const f of [10, 25]) {
    const res = await page.request.put(`${path}/frames/${f}/boxes`, { data: { boxes: [compound] } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  await page.getByRole("button", { name: "Размечать ролик" }).click();
  const editor = page.getByRole("dialog", { name: "Разметка видео" });
  const ruler = editor.getByRole("slider", { name: "Кадр", exact: true });
  await expect(ruler).toHaveAttribute("aria-valuenow", "0");
  await expect(editor.locator(".ed-top").getByRole("button", { name: /Пусто/ })).toBeVisible();
  await expect(editor.locator(".ed-top").getByRole("button", { name: "Вопрос к кадру" }).locator(".ed-tool-k")).toHaveText("C");
  await expect(editor.locator(".ve-tr").getByRole("button", { name: /Вопрос/ })).toHaveCount(0);
  const speed = editor.getByRole("combobox", { name: "Скорость" });
  await speed.click();
  await page.getByRole("option", { name: "0,5×" }).click();
  await expect(speed).toContainText("0,5×");
  const tenForward = editor.getByRole("button", { name: "Вперёд на 10 кадров (Shift+→)" });
  await expect(tenForward.locator("svg")).toHaveClass(/lucide-chevrons-right/);
  await tenForward.click();
  await expect(ruler).toHaveAttribute("aria-valuenow", "10");
  await editor.getByRole("button", { name: "Назад на 10 кадров (Shift+←)" }).click();
  await expect(ruler).toHaveAttribute("aria-valuenow", "0");
  const next = editor.getByRole("button", { name: "Следующий размеченный кадр (])", exact: true });
  await expect(next.locator("svg")).toHaveClass(/lucide-skip-forward/);
  for (const f of [10, 15, 25, 0]) {
    await next.click();
    await expect(ruler).toHaveAttribute("aria-valuenow", String(f));
  }
  await editor.getByRole("button", { name: "Предыдущий размеченный кадр ([)", exact: true }).click();
  await expect(ruler).toHaveAttribute("aria-valuenow", "25");
  await page.keyboard.press("BracketLeft");
  await expect(ruler).toHaveAttribute("aria-valuenow", "15");
  await page.keyboard.press("BracketLeft");
  await expect(ruler).toHaveAttribute("aria-valuenow", "10");
  await expect(editor.locator(".mag-cv-sh.poly:not(.mag-cv-ov)")).toHaveCount(1);
  await page.keyboard.press("KeyT");
  await detach(editor);
  const annotations = async () => (await (await page.request.get(`${path}/annotations`)).json());
  const boxes = async () => (await annotations()).singles.filter((s: { frame_no: number }) => s.frame_no === 10);
  await expect.poll(async () => (await boxes()).length).toBe(2);
  expect((await annotations()).tracks).toHaveLength(2);
  await page.keyboard.press("KeyV");
  await mergePolygons(editor);
  await expect.poll(async () => (await boxes()).length).toBe(1);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).length).toBe(2);
  await editor.locator(".mag-cv-sh.poly:not(.mag-cv-ov) .mag-cv-hit").last().click();
  await page.keyboard.press("Digit2");
  await expect.poll(async () => (await boxes()).map((b: { class_index: number }) => b.class_index).sort()).toEqual([0, 1]);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).map((b: { class_index: number }) => b.class_index)).toEqual([0, 0]);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).length).toBe(1);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await boxes()).length).toBe(2);
  await editor.locator(".ed-top").getByRole("button", { name: "Очистить кадр" }).click();
  const clear = page.getByRole("dialog", { name: "Очистить кадр?" });
  await expect(clear).toContainText("треки останутся на остальных");
  await clear.getByRole("button", { name: "Очистить", exact: true }).click();
  await expect.poll(async () => (await boxes()).length).toBe(0);
  await expect.poll(async () => (await annotations()).tracks.find((t: { id: string }) => t.id === track.id).hidden_ranges).toEqual([[10, 11]]);
  await expect.poll(async () => (await annotations()).tracks.find((t: { id: string }) => t.id === hiddenTrack.id).hidden_ranges).toEqual([[5, 12]]);
  await expect(editor.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(0);
  await editor.getByRole("button", { name: "Кадр назад (←)" }).click();
  await expect(ruler).toHaveAttribute("aria-valuenow", "9");
  await expect(editor.locator(".mag-cv-sh:not(.mag-cv-ov):not(.occluded)")).toHaveCount(1);
  await editor.getByRole("button", { name: "Кадр вперёд (→)" }).click();
  await editor.getByRole("button", { name: "Кадр вперёд (→)" }).click();
  await expect(ruler).toHaveAttribute("aria-valuenow", "11");
  await expect(editor.locator(".mag-cv-sh:not(.mag-cv-ov):not(.occluded)")).toHaveCount(1);
  expect(await editor.locator(".ve-tr").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await editor.screenshot({ path: test.info().outputPath("video-editor.png") });
});
