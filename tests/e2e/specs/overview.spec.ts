import { expect, test } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * Обзор и шапка: пустой проект говорит, что делать; «Новая таска» открывает
 * окно; Ctrl K ведёт в раздел; колокольчик и аватар открываются.
 */
test("обзор пустого проекта и шапка", async ({ page }) => {
  await signIn(page);
  const name = tag();
  const project = await (await page.request.post("/api/projects", { data: { name } })).json();

  await page.goto(`/projects/${project.code}`);
  await expect(page.getByRole("heading", { level: 1, name: "Обзор" })).toBeVisible();
  await expect(page.getByText("В проекте пока нет данных")).toBeVisible();
  await expect(page.getByRole("link", { name: "Импортировать архив" })).toBeVisible();

  await page.getByRole("button", { name: "Новая таска" }).click();
  await expect(page.getByRole("heading", { name: "Новая таска" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Ctrl K — поиск; Enter — первый результат
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("combobox", { name: "Поиск" })).toBeFocused();
  await page.keyboard.type("участ");
  await expect(page.getByRole("option", { name: /Участники/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/members$`));

  await page.getByRole("button", { name: "Уведомлений нет" }).click();
  await expect(page.getByText("Новых приглашений и заявок нет")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Новых приглашений и заявок нет")).toHaveCount(0);

  await page.getByRole("button", { name: /^Аккаунт:/ }).click();
  await expect(page.getByRole("button", { name: "Выйти", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Личный кабинет" })).toBeVisible();
});
