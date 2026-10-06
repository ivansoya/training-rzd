import { expect, test } from "@playwright/test";
import { signIn } from "../helpers";

/**
 * «Мои агенты»: пустой список, новый агент «Кадр → Сеть → Выход», недоделка подсвечена и не даёт
 * сохранить версию, узел из палитры встаёт в цепочку, окно весов, назад в список, удаление окном.
 */

test("агент: новый, NMS в цепочку, окно весов, назад, удаление", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);

  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Мои агенты", level: 1 })).toBeVisible();
  await expect(page.getByText("Агентов пока нет")).toBeVisible();

  await page.getByRole("button", { name: "Собрать первого агента" }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Имя агента")).toHaveValue("Новый агент");
  await expect(page.locator(".ge-node")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  // Провод от кадра подписан словом, а не числом рамок.
  await expect(page.locator(".ge-wl", { hasText: "кадр" })).toHaveCount(1);

  // Сеть без весов: подсказка на холсте, версию не сохранить.
  await expect(page.locator(".ge-notes")).toContainText("выберите веса");
  await expect(page.getByRole("button", { name: /Сохранить версию 1/ })).toBeDisabled();

  // Щелчок по палитре — NMS встаёт в провод перед «Выходом», шторка показывает его параметры.
  await page.getByRole("complementary", { name: "Узлы" }).getByRole("button", { name: "NMS", exact: true }).click();
  await expect(page.locator(".ge-node")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(page.locator(".ge-drawer .ge-sec-h b").first()).toHaveText("NMS");
  await expect(page.getByText("черновик сохранён")).toBeVisible({ timeout: 10_000 });

  // Сеть: в шторке кнопка весов, окно полки открывается и закрывается.
  await page.locator(".ge-node", { hasText: "Сеть" }).click();
  await page.locator(".ge-drawer").getByRole("button", { name: "Выбрать веса" }).click();
  const picker = page.getByRole("dialog", { name: "Веса для сети" });
  await expect(picker).toBeVisible();
  await expect(picker.getByText("Полка пуста")).toBeVisible();
  await picker.getByRole("button", { name: "Закрыть" }).first().click();
  await expect(picker).toBeHidden();

  await page.getByRole("link", { name: "К моим агентам" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  const row = page.locator(".gl-row", { hasText: "Новый агент" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("только черновик");
  await expect(row).toContainText("не запускали");

  await row.getByRole("button", { name: /Действия с агентом/ }).click();
  await page.getByRole("button", { name: /Удалить…/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Удалить" }).click();
  await expect(page.getByText("Агентов пока нет")).toBeVisible();
});
