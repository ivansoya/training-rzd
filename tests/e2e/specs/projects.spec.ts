import { expect, test } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * «Проекты» и «Датасеты»: карточка проекта с цифрами, фильтр по роли и поиск;
 * пустой проект говорит, откуда берутся датасеты; старый адрес датасета ведёт в галерею.
 */
test("проекты карточками и пустые датасеты", async ({ page }) => {
  await signIn(page);
  const name = tag();
  const project = await (await page.request.post("/api/projects", { data: { name } })).json();

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Проекты" })).toBeVisible();
  const card = page.getByRole("link", { name: new RegExp(name) });
  await expect(card).toBeVisible();
  await expect(card.getByText("Обучения не было")).toBeVisible();
  await expect(card.getByText("Кадров")).toBeVisible();

  // Я участник — своих проектов там нет; поиск мимо — подсказка и сброс
  await page.getByRole("button", { name: /^Я участник/ }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: /^Все/ }).click();
  await page.getByRole("searchbox", { name: "Найти проект" }).fill("нет-такого-проекта");
  await expect(page.getByText("Под условия не подошёл ни один проект")).toBeVisible();
  await page.getByRole("button", { name: "Сбросить" }).click();
  await expect(card).toBeVisible();

  await card.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}$`));

  await page.goto(`/projects/${project.code}/datasets`);
  await expect(page.getByRole("heading", { level: 1, name: "Датасеты" })).toBeVisible();
  await expect(page.getByText("Датасетов пока нет")).toBeVisible();
  await expect(page.getByRole("link", { name: "Импорт архива" })).toBeVisible();

  // Сохранённая ссылка на датасет и «Все кадры» обзора ведут сюда же
  await page.goto(`/projects/${project.code}/datasets/00000000-0000-0000-0000-000000000000`);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/datasets\\?ds=`));
  await page.goto(`/projects/${project.code}?view=frames`);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/datasets$`));
});
