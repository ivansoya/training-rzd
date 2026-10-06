import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * Редактор кадров «Фокус»: рамка рисуется и записывается, строка объекта раскрывается,
 * цифра перекрашивает выбранное, «Отложить» и «Брак» ставят состояние, Tab прячет панели,
 * «?» открывает клавиши, Esc снимает слои и выходит к таске.
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

test("редактор кадров: рамка, класс, решения, панели", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  for (const name of ["Вагон", "Гайка"]) {
    expect((await page.request.post(`/api/projects/${project.code}/classes`, { data: { name } })).ok()).toBeTruthy();
  }
  const task = await (await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: "Фокус" } })).json();
  await page.goto("/");
  for (const [i, color] of ["#5a6", "#a65"].entries()) {
    const up = await page.request.post(`/api/tasks/${task.id}/images`, {
      multipart: { files: { name: `kadr-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: await jpeg(page, color) } },
    });
    expect(up.ok(), await up.text()).toBeTruthy();
  }
  const images = async () => (await (await page.request.get(`/api/tasks/${task.id}/images?limit=10`)).json()).images as
    { id: string; file_name: string; task_status: string; annotations: number; boxes: { class_index: number }[] }[];
  const [first] = (await images()).sort((a, b) => a.file_name.localeCompare(b.file_name));

  await page.goto(`/projects/${project.code}/tasks/${task.id}?frame=${first.id}`);
  const ed = page.getByRole("dialog", { name: "Разметка кадров" });
  await expect(ed).toBeVisible();
  await expect(ed.locator(".ed-h")).toContainText("Фокус");
  await expect(ed.locator(".ed-h")).toContainText(/Кадр\s*1\s*из\s*2/);
  await expect(ed.locator(".ed-cls")).toContainText("Вагон");

  // Рамка: B и протяжка по кадру
  await page.keyboard.press("b");
  await expect(ed.getByRole("button", { name: "Рамка" })).toHaveAttribute("aria-pressed", "true");
  const frame = await ed.locator(".mag-cv-frame").boundingBox();
  expect(frame).not.toBeNull();
  const { x, y, width: w, height: h } = frame!;
  await page.mouse.move(x + w * 0.3, y + h * 0.3);
  await page.mouse.down();
  await page.mouse.move(x + w * 0.5, y + h * 0.5, { steps: 6 });
  await page.mouse.move(x + w * 0.7, y + h * 0.7, { steps: 6 });
  await page.mouse.up();
  const side = ed.locator(".fe-side");
  await expect(side.locator(".fe-obj")).toHaveCount(1);
  await expect(ed.locator(".ed-save")).toContainText("Сохранено", { timeout: 15_000 });

  // Нарисованная рамка выбрана — её строка раскрыта; щелчок по строке сворачивает и снова раскрывает
  await expect(side.locator(".fe-obj-b")).toBeVisible();
  await side.locator(".fe-obj-r").first().click();
  await expect(side.locator(".fe-obj-b")).toHaveCount(0);
  await side.locator(".fe-obj-r").first().click();
  await expect(side.locator(".fe-obj-b")).toBeVisible();
  await expect(ed.locator(".mag-cv-h")).toHaveCount(8);
  await page.keyboard.press("2");
  await expect(side.locator(".fe-obj-r").first()).toContainText("Гайка");
  await expect(ed.locator(".ed-save")).toContainText("Сохранено", { timeout: 15_000 });
  await expect.poll(async () => (await images()).find((i) => i.id === first.id)?.boxes[0]?.class_index).toBe(1);

  // Щелчок по подписи выбирает её рамку
  await page.keyboard.press("Escape");
  await expect(side.locator(".fe-obj-b")).toHaveCount(0);
  await ed.locator(".mag-cv-lb").first().click();
  await expect(side.locator(".fe-obj-b")).toBeVisible();

  // Мелкая рамка: у выбранной всё равно четыре угловых якоря
  await page.keyboard.press("b");
  await page.mouse.move(x + w * 0.05, y + h * 0.05);
  await page.mouse.down();
  await page.mouse.move(x + w * 0.05 + 30, y + h * 0.05 + 28, { steps: 4 });
  await page.mouse.up();
  await expect(side.locator(".fe-obj")).toHaveCount(2);
  await expect(ed.locator(".mag-cv-h")).toHaveCount(4);
  // Подпись мелкой рамки — только пока она выбрана
  await expect(ed.locator(".mag-cv-lb:not(.off)")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await page.mouse.move(x + w * 0.9, y + h * 0.9);
  await expect(ed.locator(".mag-cv-lb:not(.off)")).toHaveCount(1);
  await side.locator(".fe-obj-r").nth(1).click();
  await page.keyboard.press("Delete");
  await expect(side.locator(".fe-obj")).toHaveCount(1);
  await expect(ed.locator(".ed-save")).toContainText("Сохранено", { timeout: 15_000 });

  // Отложить — кадр отложен, редактор идёт дальше
  await ed.getByRole("button", { name: /Отложить/ }).click();
  await expect(ed.locator(".ed-h")).toContainText(/Кадр\s*2\s*из\s*2/);
  await expect.poll(async () => (await images()).find((i) => i.id === first.id)?.task_status).toBe("skipped");

  // Брак второго кадра
  const second = (await images()).find((i) => i.id !== first.id)!;
  await page.keyboard.press("x");
  await expect.poll(async () => (await images()).find((i) => i.id === second.id)?.task_status).toBe("deleted");
  await expect(ed.getByRole("button", { name: /Вернуть/ })).toBeVisible();

  // Панели прячутся и возвращаются
  await page.keyboard.press("Tab");
  await expect(ed.locator(".fe-side")).toHaveCount(0);
  await expect(ed.locator(".ed-top")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(ed.locator(".fe-side")).toBeVisible();

  // Клавиши — окно поверх; Esc закрывает его, а не редактор
  await page.keyboard.press("?");
  const keys = page.getByRole("dialog", { name: "Клавиши" });
  await expect(keys).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(keys).toBeHidden();
  await expect(ed).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(ed).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]frame=/);
});
