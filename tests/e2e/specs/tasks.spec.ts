import { expect, test } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * Таски: доска по состояниям и страница таски (вариант «Паспорт сбоку») — пустая таска,
 * взять в работу, загрузить изображение, Enter открывает редактор, закрытие спрашивает окном.
 */

test("таски: доска, страница, паспорт", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  const name = `Обход ${tag()}`;
  const task = await (await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name } })).json();

  await page.goto(`/projects/${project.code}/tasks`);
  await expect(page.getByRole("heading", { name: "Таски" })).toBeVisible();
  const queued = page.getByRole("region", { name: "На очереди" });
  await expect(queued.locator(".tb-card")).toContainText(name);
  await expect(queued).toContainText("пустая");

  await queued.locator(".tb-card", { hasText: name }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Путь" }).getByRole("link", { name: "Таски" })).toBeVisible();
  await expect(page.getByText("В таске пока нет кадров")).toBeVisible();
  const pass = page.getByRole("complementary", { name: "Паспорт таски" });
  await expect(pass).toContainText("На очереди");

  await pass.getByRole("button", { name: "Взять в работу" }).click();
  await expect(pass).toContainText("В работе");
  await expect(pass.getByRole("button", { name: "Готово" })).toBeVisible();

  // Кадр рисуем в браузере: настоящий jpeg без файлов в репозитории
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 64; c.height = 48;
    const g = c.getContext("2d")!;
    g.fillStyle = "#5a6"; g.fillRect(0, 0, 64, 48);
    return c.toDataURL("image/jpeg").split(",")[1];
  });
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "kadr-1.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64"),
  });
  await page.getByRole("button", { name: "Загрузить 1" }).click();
  const files = page.locator(".tp-src", { hasText: "Изображения" });
  await expect(files).toBeVisible();
  await expect(pass.getByRole("button", { name: /Не тронуто/ })).toContainText("1");

  // Enter — «Размечать»: редактор открывается на кадре, кадр в адресе
  await page.locator("h1").click();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/[?&]frame=/);
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/[?&]frame=/);

  // Закрытие спрашивает окном и честно говорит, что удалится
  await pass.getByRole("button", { name: "Закрыть таску…" }).click();
  const ask = page.getByRole("dialog", { name: "Закрыть таску?" });
  await expect(ask).toContainText("черновой кадр");
  await ask.getByRole("button", { name: "Отмена" }).click();
  await expect(ask).toBeHidden();

  await pass.getByRole("button", { name: "Вся история" }).click();
  await expect(page.getByRole("dialog", { name: "История таски" })).toContainText("Загружено");
});

test("таски: перетаскивание по доске меняет состояние", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  const name = `Тащим ${tag()}`;
  const task = await (await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name } })).json();
  const status = async () => (await (await page.request.get(`/api/tasks/${task.id}`)).json()).status;

  await page.goto(`/projects/${project.code}/tasks`);
  const col = (n: string) => page.getByRole("region", { name: n });
  const card = page.locator(".tb-card", { hasText: name });
  await expect(col("На очереди")).toContainText(name);

  await card.dragTo(col("В работе"));
  await expect(col("В работе")).toContainText(name);
  await expect.poll(status).toBe("in_progress");

  // Закрытие спрашивает окном; отмена оставляет таску на месте
  await card.dragTo(col("Закрыто"));
  const ask = page.getByRole("dialog", { name: `Закрыть «${name}»?` });
  await ask.getByRole("button", { name: "Отмена" }).click();
  await expect(col("В работе")).toContainText(name);
  await card.dragTo(col("Закрыто"));
  await ask.getByRole("button", { name: "Закрыть таску" }).click();
  await expect(col("Закрыто")).toContainText(name);
  await expect.poll(status).toBe("closed");
});
