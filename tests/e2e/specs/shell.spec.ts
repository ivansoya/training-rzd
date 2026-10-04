import { expect, test } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * Каркас: сайдбар на месте, раздел подсвечен, крошки ведут назад, переключатель
 * проекта открывается, а вне проекта сайдбар помнит последний открытый.
 */
test("каркас: сайдбар, крошки, переключатель и последний проект", async ({ page }) => {
  await signIn(page);
  const name = tag();
  const project = await (await page.request.post("/api/projects", { data: { name } })).json();

  await page.goto(`/projects/${project.code}/classes`);
  const nav = page.getByRole("navigation", { name: "Разделы" });
  await expect(nav.getByRole("link", { name: "Классы" })).toHaveAttribute("aria-current", "page");
  const crumbs = page.getByRole("navigation", { name: "Путь" });
  await expect(crumbs).toContainText(name);
  await expect(crumbs).toContainText("Классы");
  await expect(page).toHaveTitle(new RegExp(`^${name} — Классы`));

  // Наборы и прогоны — одна страница, раздел по ?tab
  await nav.getByRole("link", { name: "Прогоны" }).click();
  await expect(nav.getByRole("link", { name: "Прогоны" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Сменить проект" }).click();
  await expect(page.getByRole("button", { name: /Все проекты/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // Вне проекта — последний открытый проект остаётся в сайдбаре
  await page.goto("/hardware");
  await expect(nav.getByRole("link", { name: "Оборудование" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Оборудование" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Сменить проект" })).toContainText(name);
  await nav.getByRole("link", { name: "Таски" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/tasks$`));

  // Чужой код — «не найден» с путём назад
  await page.goto("/projects/NOPE-NOPE");
  await expect(page.getByText("Проект не найден")).toBeVisible();
  await expect(page.getByRole("link", { name: "К проектам" })).toBeVisible();
});
