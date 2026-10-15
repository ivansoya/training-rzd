import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * Таска из датасета и «Фокус» в датасете (решения 14–15.10.2026): отбор как в Фото, выбранные кадры уходят
 * новой таской копиями, на странице таски — блок «Из датасета»; «Фокус» датасета открыт просмотром, после
 * «Править» — без «Отложить», E и X спрашивают окном; кадр с живой копией — только для чтения.
 */

async function jpeg(page: Page, color: string): Promise<Buffer> {
  const b64 = await page.evaluate((c) => {
    const cv = document.createElement("canvas");
    cv.width = 160; cv.height = 120;
    const g = cv.getContext("2d")!;
    g.fillStyle = c; g.fillRect(0, 0, 160, 120);
    return cv.toDataURL("image/jpeg").split(",")[1];
  }, color);
  return Buffer.from(b64, "base64");
}

test("таска из датасета и «Фокус» датасета", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  const cls = await (await page.request.post(`/api/projects/${project.code}/classes`, { data: { name: "Вагон" } })).json();
  const task = await (await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: "Источник" } })).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });
  await page.goto("/");
  for (const [i, color] of ["#5a6", "#a65", "#56a"].entries()) {
    const up = await page.request.post(`/api/tasks/${task.id}/images`, {
      multipart: { files: { name: `kadr-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: await jpeg(page, color) } },
    });
    expect(up.ok(), await up.text()).toBeTruthy();
  }
  const frames = (await (await page.request.get(`/api/tasks/${task.id}/images?limit=10`)).json()).images as { id: string }[];
  for (const f of frames) {
    await page.request.put(`/api/images/${f.id}/annotations`,
      { data: { boxes: [{ class_index: cls.class_index, x: 10, y: 10, w: 60, h: 40 }] } });
  }
  expect((await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "done" } })).ok()).toBeTruthy();

  // Отбор как в Фото (15.10.2026): полосы до отбора нет, флажок включает, дальше щелчок по плитке выбирает
  await page.goto(`/projects/${project.code}/datasets`);
  const tiles = page.locator(".fr-tile");
  await expect(tiles).toHaveCount(3);
  await expect(page.locator(".fr-take-bar")).toHaveCount(0);
  await tiles.nth(0).hover();
  await tiles.nth(0).locator(".fr-sel").click();
  await tiles.nth(1).locator(".fr-open").click({ modifiers: ["Shift"] });
  await expect(page.locator(".fr-take-bar")).toContainText("выбрано 2");
  await expect(page.locator(".ed.fe")).toHaveCount(0);
  await page.locator(".fr-take-bar").getByRole("button", { name: /В таску/ }).click();
  await page.getByRole("button", { name: /Новая таска/ }).click();
  const dialog = page.getByRole("dialog", { name: "Новая таска" });
  await expect(dialog.locator(".ct-from")).toContainText("Из датасета: 2 кадра");
  await dialog.getByLabel("Название").fill("Проверка");
  await dialog.getByRole("button", { name: "Создать таску" }).click();
  await expect(page).toHaveURL(/\/tasks\//);
  await expect(page.locator(".tp-src").filter({ hasText: "Из датасета" })).toBeVisible();

  // «Фокус» датасета на свободном кадре: открыт просмотром, правка — по «Править»
  await page.goto(`/projects/${project.code}/datasets`);
  await expect(page.locator(".fr-tile.held")).toHaveCount(2);
  await tiles.nth(2).locator(".fr-open").click();
  const bar = page.getByLabel("Решение по кадру");
  await expect(page.locator(".ed-top")).toHaveCount(0);
  await expect(bar).not.toContainText("Удалить из датасета");
  await page.getByRole("button", { name: "Править" }).click();
  await expect(bar).toContainText("Удалить из датасета");
  await expect(bar).not.toContainText("Отложить");
  await expect(page.locator(".ed-title")).toContainText("Кадр 3 из 3");
  await page.keyboard.press("KeyE");
  await expect(page.getByRole("dialog", { name: "Сделать кадр фоновым?" })).toBeVisible();
  await page.getByRole("button", { name: "Отмена" }).click();

  // Кадр с живой копией — только для чтения, плашка ведёт в таску
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".ed-notes")).toContainText("В таске «Проверка»");
  await expect(page.locator(".ed-top")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Готово" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".ed.fe")).toHaveCount(0);
});
