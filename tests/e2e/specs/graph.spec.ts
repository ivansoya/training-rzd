import { expect, test } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * «Аугментации»: пустая вкладка проекта, новый граф прямо из проекта (в библиотеку и сразу сюда),
 * узел из палитры встаёт в цепочку, «назад» возвращает в проект, удаление из библиотеки окном.
 */

test("граф: новый из проекта, узел в цепочку, назад в проект, удаление", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();

  await page.goto(`/projects/${project.code}/aug`);
  await expect(page.getByRole("heading", { name: "Аугментации", level: 1 })).toBeVisible();
  await expect(page.getByText("К проекту не подключён ни один граф")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Разделы" }).getByRole("link", { name: "Аугментации" }))
    .toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Новый граф" }).click();
  await expect(page).toHaveURL(/\/augment\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Имя графа")).toHaveValue("Новый граф");
  await expect(page.locator(".ge-node")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  // Щелчок по палитре — узел встаёт в провод «Источник → Выход», шторка показывает его параметры
  await page.getByRole("complementary", { name: "Узлы" }).getByRole("button", { name: "Поворот", exact: true }).click();
  await expect(page.locator(".ge-node")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.locator(".ge-drawer .ge-sec-h b").first()).toHaveText("Поворот");
  await expect(page.getByText("черновик сохранён")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("link", { name: "К графам проекта" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/aug$`));
  await expect(page.locator(".gl-row", { hasText: "Новый граф" })).toBeVisible();

  await page.goto("/augment");
  await expect(page.getByRole("heading", { name: "Мои графы", level: 1 })).toBeVisible();
  const row = page.locator(".gl-row", { hasText: "Новый граф" });
  await row.getByRole("button", { name: /Действия с графом/ }).click();
  await page.getByRole("button", { name: /Удалить…/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Удалить" }).click();
  await expect(page.getByText("Графов пока нет")).toBeVisible();
});
