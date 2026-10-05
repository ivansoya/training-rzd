import { expect, test } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * «Наборы»: пустой список с шагами и кнопкой, мастер без данных объясняет, почему дальше нельзя,
 * несуществующий набор — понятный отказ со ссылкой назад.
 */

test("наборы: пустой список, мастер и отказ на чужой адрес", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();

  await page.goto(`/projects/${project.code}/training`);
  await expect(page.getByRole("heading", { name: "Наборы", level: 1 })).toBeVisible();
  await expect(page.getByText("Наборов пока нет")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Разделы" });
  await expect(nav.getByRole("link", { name: "Наборы" })).toHaveAttribute("aria-current", "page");

  // Мастер: в проекте нет датасетов — шаг объясняет, и дальше не пускает
  await page.getByRole("link", { name: "Собрать набор" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/training/new$`));
  await expect(page.getByRole("heading", { name: "Новый набор", level: 1 })).toBeVisible();
  await expect(page.getByText("В проекте нет ни одного датасета")).toBeVisible();
  await expect(page.getByText("Выберите хотя бы один датасет.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Дальше — деление/ })).toBeDisabled();
  await expect(page.getByRole("navigation", { name: "Шаги мастера" }).getByRole("button", { name: /Деление/ })).toBeDisabled();
  await page.getByRole("link", { name: "Отмена" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/training$`));

  // Несуществующий набор
  await page.goto(`/projects/${project.code}/trainsets/00000000-0000-0000-0000-000000000000`);
  await expect(page.getByText("Набор не найден")).toBeVisible();
  await page.getByRole("link", { name: "Все наборы" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/training$`));
});
