import { expect, test } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * «Прогоны»: история на /runs, пустое состояние, окно запуска без готовых наборов,
 * старые адреса ведут на новые, у несуществующего номера — понятный отказ.
 */

test("прогоны: пустая история, окно запуска и старые адреса", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();

  await page.goto(`/projects/${project.code}/runs`);
  await expect(page.getByRole("heading", { name: "Обучения", level: 1 })).toBeVisible();
  await expect(page.getByText("Обучений ещё не было")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Разделы" });
  await expect(nav.getByRole("link", { name: "Обучения" })).toHaveAttribute("aria-current", "page");

  // Наборов нет — окно объясняет, а не даёт запустить
  await page.getByRole("button", { name: "Новое обучение" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новое обучение" });
  await expect(dialog.getByText("Готовых наборов нет")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Запустить" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Старая вкладка «Обучения» и старая ссылка на прогон
  await page.goto(`/projects/${project.code}/training?tab=runs`);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/runs$`));
  await page.goto(`/projects/${project.code}/training/runs/00000000-0000-0000-0000-000000000000`);
  await expect(page).toHaveURL(new RegExp(`/runs/00000000-0000-0000-0000-000000000000$`));
  await expect(page.getByText("Обучение не найдено.")).toBeVisible();
  await page.getByRole("link", { name: "К обучениям" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/runs$`));

  // Наборы остались на /training и ведут к прогонам
  await page.goto(`/projects/${project.code}/training`);
  await expect(page.getByRole("link", { name: "Обучения" }).last()).toBeVisible();
});
