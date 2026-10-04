import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * Окна проекта: импорт архива проходит все шаги в окне одного размера,
 * экспорт собирает архив, «Новая таска» ставит фокус в название.
 */

// Маленький YOLO-архив: три класса, из них один без имени в data.yaml, и одна битая строка
function archive(): string {
  const path = `/tmp/${tag()}.zip`;
  execFileSync("python3", ["-c", `
import io, sys, zipfile
from PIL import Image
def jpg(c):
    b = io.BytesIO(); Image.new("RGB", (96, 64), c).save(b, "JPEG"); return b.getvalue()
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("data.yaml", "names:\\n  0: вагон\\n  1: опора\\n")
    for i in range(6):
        sp = "val" if i % 3 == 2 else "train"
        z.writestr(f"images/{sp}/f{i}.jpg", jpg((40 + i * 20, 60, 90)))
        z.writestr(f"labels/{sp}/f{i}.txt", f"{i % 3} 0.5 0.5 0.2 0.2\\n")
    z.writestr("images/train/bad.jpg", jpg((10, 10, 10)))
    z.writestr("labels/train/bad.txt", "0 1.7 0.5 0.2 0.2\\n")
`, path]);
  return path;
}

// Размер раскладки, а не на экране: анимация появления масштабирует окно
const dialogSize = (page: import("@playwright/test").Page) => page.locator(".ui-dialog").evaluate((d) =>
  `${(d as HTMLElement).offsetWidth}x${(d as HTMLElement).offsetHeight}`);

test("импорт архива окном, экспорт и новая таска", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();

  // --- импорт: окно одного размера на каждом шаге ---
  await page.goto(`/projects/${project.code}/import`);
  const dialog = page.getByRole("dialog", { name: "Импорт архива" });
  await expect(dialog.getByText("Перетащите zip сюда")).toBeVisible();
  const size = await dialogSize(page);

  await dialog.locator("input[type=file]").setInputFiles(archive());
  await expect(dialog.getByRole("button", { name: "К классам" })).toBeVisible({ timeout: 60_000 });
  expect(await dialogSize(page)).toBe(size);
  await expect(dialog.getByText("1 изображение пропущено")).toBeVisible();

  await dialog.getByRole("button", { name: "К классам" }).click();
  expect(await dialogSize(page)).toBe(size);
  await expect(dialog.getByText("1 класс без названия")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Записать в проект" })).toBeDisabled();
  await dialog.getByLabel("Название класса 2").fill("путевая машина");
  await dialog.getByRole("button", { name: "Записать в проект" }).click();

  await expect(dialog.getByRole("link", { name: "Открыть датасет" })).toBeVisible({ timeout: 60_000 });
  expect(await dialogSize(page)).toBe(size);
  await expect(dialog.getByText("6 изображений записано")).toBeVisible();
  await dialog.locator(".ui-dialog-f").getByRole("button", { name: "Закрыть" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}$`));

  // --- экспорт: предпросмотр → сборка → ссылка на архив ---
  await page.getByRole("button", { name: "Экспорт" }).click();
  const exp = page.getByRole("dialog", { name: "Экспорт проекта" });
  await expect(exp.getByText("Предпросмотр пересчитан")).toBeVisible({ timeout: 20_000 });
  await exp.getByRole("button", { name: "Экспортировать" }).click();
  await expect(exp.getByRole("link", { name: "Скачать архив" })).toBeVisible({ timeout: 60_000 });
  await expect(exp.getByText("Архив готов", { exact: true })).toBeVisible();
  await exp.locator(".ui-dialog-f").getByRole("button", { name: "Закрыть" }).click();

  // --- новая таска: фокус в названии, а не на крестике ---
  await page.getByRole("button", { name: "Новая таска" }).click();
  const task = page.getByRole("dialog", { name: "Новая таска" });
  await expect(task.getByLabel("Название")).toBeFocused();
  await expect(task.getByRole("button", { name: "Создать и загрузить кадры" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(task).toHaveCount(0);

  // --- повторный импорт: архив сверяется с классами проекта ---
  await page.getByRole("link", { name: "Импорт архива" }).click();
  const again = page.getByRole("dialog", { name: "Импорт архива" });
  await again.locator("input[type=file]").setInputFiles(archive());
  await again.getByRole("button", { name: "К классам" }).click({ timeout: 60_000 });
  await expect(again.getByText("2 класса сопоставлено с проектом")).toBeVisible();
  // Новый класс с занятым именем — нельзя: надо сопоставить
  await again.getByLabel("Название класса 2").fill("Путевая машина");
  await expect(again.getByText("уже есть в проекте")).toBeVisible();
  await expect(again.getByRole("button", { name: "Записать в проект" })).toBeDisabled();
  await page.screenshot({ path: "test-results/redesign/app-import-merge.png" }).catch(() => undefined);
  await again.getByRole("combobox", { name: "Класс проекта для класса 2" }).click();
  await page.getByRole("option", { name: /путевая машина/ }).click();
  await expect(again.getByText("3 класса сопоставлено с проектом")).toBeVisible();
  await again.getByRole("button", { name: "Записать в проект" }).click();
  await expect(again.getByRole("link", { name: "Открыть датасет" })).toBeVisible({ timeout: 60_000 });
  const classes = await (await page.request.get(`/api/projects/${project.code}/classes`)).json();
  expect(classes.classes.map((c: { name: string }) => c.name).sort()).toEqual(["вагон", "опора", "путевая машина"]);
});
