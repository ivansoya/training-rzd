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
  await editor.getByRole("button", { name: "Следующий кадр (→)", exact: true }).click();
  const emptyFrame = editor.locator(".ed-top").getByRole("button", { name: /Пусто/ });
  await expect(emptyFrame).toBeVisible();
  await emptyFrame.click();
  await expect(emptyFrame).toHaveAttribute("aria-pressed", "true");
  await emptyFrame.click();
  await expect(emptyFrame).toHaveAttribute("aria-pressed", "false");
  await editor.getByRole("button", { name: "Предыдущий кадр (←)", exact: true }).click();
  await page.keyboard.press("BracketLeft");
  await expect(header).toContainText("frame-3.jpg");
  await page.keyboard.press("BracketRight");
  await expect(header).toContainText("frame-1.jpg");

  await detach(editor);
  const boxes = async () => (await listing()).find((im: { id: string }) => im.id === images[0].id).boxes;
  await expect.poll(async () => (await boxes()).length).toBe(2);
  await page.keyboard.press("Digit2");
  await expect.poll(async () => (await boxes()).map((b: { class_index: number }) => b.class_index).sort()).toEqual([0, 1]);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).map((b: { class_index: number }) => b.class_index)).toEqual([0, 0]);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).length).toBe(1);
  await expect(editor.locator(".mag-cv-sh.poly .mag-cv-hit")).toHaveCount(2);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await boxes()).length).toBe(2);
  await page.reload();
  await expect(editor.locator(".mag-cv-sh.poly:not(.mag-cv-ov)")).toHaveCount(2);
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
  const speed = editor.getByRole("combobox", { name: "Скорость" });
  await speed.click();
  await page.getByRole("option", { name: "½" }).click();
  await expect(speed).toContainText("½");
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
  expect((await annotations()).tracks).toHaveLength(1);
  await page.keyboard.press("Digit2");
  await expect.poll(async () => (await boxes()).map((b: { class_index: number }) => b.class_index).sort()).toEqual([0, 1]);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).map((b: { class_index: number }) => b.class_index)).toEqual([0, 0]);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await boxes()).length).toBe(1);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await boxes()).length).toBe(2);
  expect(await editor.locator(".ve-tr").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await editor.screenshot({ path: test.info().outputPath("video-editor.png") });
});
