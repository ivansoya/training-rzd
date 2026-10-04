import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * «Классы»: таблица с долей val, группы в фильтре, правка в панели справа,
 * перенос разметки при удалении и вкладка «Таги».
 */

// Шесть кадров: вагон и опора через один, каждый третий — val
function archive(): Buffer {
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
        z.writestr(f"labels/{sp}/f{i}.txt", f"{i % 2} 0.5 0.5 0.2 0.2\\n")
`, path]);
  return readFileSync(path);
}

async function waitJob(page: Page, id: string) {
  for (let i = 0; i < 120; i++) {
    const job = await (await page.request.get(`/api/jobs/${id}`)).json();
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(JSON.stringify(job));
    await page.waitForTimeout(500);
  }
  throw new Error(`Джоба ${id} не закончилась`);
}

async function importProject(page: Page) {
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  const base = `/api/projects/${project.code}`;
  const up = await page.request.post(`${base}/import`, {
    multipart: { file: { name: "data.zip", mimeType: "application/zip", buffer: archive() } },
  });
  expect(up.ok(), await up.text()).toBeTruthy();
  await waitJob(page, (await up.json()).job_id);
  const commit = await page.request.post(`${base}/import/commit`, {
    data: { dataset_name: "Первый", classes: [{ class_index: 0, name: "вагон" }, { class_index: 1, name: "опора" }] },
  });
  expect(commit.ok(), await commit.text()).toBeTruthy();
  await waitJob(page, (await commit.json()).job_id);
  return project as { code: string };
}

const row = (page: Page, name: string) => page.locator("tr.cls-row", { has: page.getByText(name, { exact: true }) });

test("классы: таблица, группы, правка и судьба разметки", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const project = await importProject(page);

  await page.goto(`/projects/${project.code}/classes`);
  await expect(page.getByRole("heading", { level: 1, name: "Классы" })).toBeVisible();
  await expect(page.getByText("2 класса · 6 боксов")).toBeVisible();
  // вагон — кадры 0, 2, 4: два train и один val
  await expect(row(page, "вагон").locator("td").nth(3)).toHaveText("3");
  await expect(row(page, "вагон").locator("td").nth(4)).toHaveText("3");
  await expect(row(page, "вагон").getByText("33 %")).toBeVisible();
  await expect(page.getByText("Выберите класс", { exact: true })).toBeVisible();
  const panel = page.locator(".cls-side");

  // --- группа заводится из фильтра ---
  await page.getByRole("button", { name: "Все группы" }).click();
  await page.getByRole("button", { name: "Новая группа" }).click();
  await expect(panel.getByLabel("Название")).toBeFocused();
  await panel.getByLabel("Название").fill("Подвижной состав");
  await panel.getByRole("button", { name: "Создать группу" }).click();
  await expect(panel.getByText("Изменить группу")).toBeVisible();

  // --- правка класса: группа, цвет, имя ---
  await row(page, "вагон").click();
  await expect(panel.getByText("Изменить класс")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Сохранить" })).toBeDisabled();
  await panel.getByRole("combobox", { name: "Группа" }).click();
  await page.getByRole("option", { name: "Подвижной состав" }).click();
  await panel.getByRole("radio", { name: "Цвет #0090ff" }).click();
  await expect(panel.getByRole("radio", { name: "Цвет #0090ff" })).toHaveAttribute("aria-checked", "true");
  await panel.getByLabel("Название").fill("вагон грузовой");
  await panel.getByRole("button", { name: "Сохранить" }).click();
  await expect(row(page, "вагон грузовой")).toContainText("Подвижной состав");
  await expect(panel.getByRole("button", { name: "Сохранить" })).toBeDisabled();

  // --- отбор по группе и поиск ---
  await page.getByRole("button", { name: "Все группы" }).click();
  await page.locator(".cls-gopt").getByRole("button", { name: /Подвижной состав/ }).first().click();
  await expect(page.locator("tr.cls-row")).toHaveCount(1);
  await expect(page.getByText("1 из 2")).toBeVisible();
  await page.getByRole("button", { name: "Подвижной состав", exact: true }).click();
  await page.getByRole("button", { name: /^Все группы/ }).click();
  await page.getByRole("searchbox", { name: "Найти класс" }).fill("опор");
  await expect(page.locator("tr.cls-row")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Найти класс" }).fill("");

  // --- новый класс: фокус в имени, Enter создаёт, клавиша редактора третья ---
  await page.getByRole("button", { name: "Новый класс" }).first().click();
  await expect(panel.getByLabel("Название")).toBeFocused();
  await panel.getByLabel("Название").fill("шпала");
  await panel.getByLabel("Название").press("Enter");
  await expect(row(page, "шпала")).toHaveClass(/\bon\b/);
  await expect(panel.locator(".ui-kbd")).toHaveText("3");

  // --- удаление: судьба разметки появляется только по кнопке ---
  await row(page, "вагон грузовой").click();
  await expect(panel.getByText("Что сделать с разметкой при удалении")).toHaveCount(0);
  await panel.getByRole("button", { name: "Удалить класс" }).click();
  await expect(panel.getByRole("radio", { name: /Перенести в другой класс/ })).toBeChecked();
  await expect(panel.getByRole("button", { name: "Перенести и удалить" })).toBeDisabled();
  await panel.getByRole("combobox", { name: "Куда перенести" }).click();
  await page.getByRole("option", { name: /опора/ }).click();
  await expect(panel.getByText("3 бокса станут «опора»")).toBeVisible();
  await panel.getByRole("button", { name: "Перенести и удалить" }).click();
  await expect(row(page, "вагон грузовой")).toHaveCount(0);
  await expect(row(page, "опора").locator("td").nth(3)).toHaveText("6");
  await expect(page.getByText("Выберите класс", { exact: true })).toBeVisible();

  // Пустой класс — без выбора, просто удаление
  await row(page, "шпала").click();
  await panel.getByRole("button", { name: "Удалить класс" }).click();
  await expect(panel.getByText("На классе нет разметки")).toBeVisible();
  await panel.getByRole("button", { name: "Удалить класс" }).click();
  await expect(row(page, "шпала")).toHaveCount(0);

  // --- группа удаляется из той же панели, классы остаются без группы ---
  await page.getByRole("button", { name: "Все группы" }).click();
  await page.getByRole("button", { name: "Изменить группу «Подвижной состав»" }).click();
  await panel.getByRole("button", { name: "Удалить группу" }).click();
  await expect(panel.getByText("В группе нет классов.")).toBeVisible();
  await panel.getByRole("button", { name: "Удалить группу" }).click();
  await expect(page.getByText("Выберите класс", { exact: true })).toBeVisible();
});

test("таги — вкладка раздела классов", async ({ page }) => {
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  await page.goto(`/projects/${project.code}/classes`);
  await page.getByRole("link", { name: "Таги" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.code}/tags$`));
  await expect(page.getByRole("heading", { level: 1, name: "Классы" })).toBeVisible();
  await expect(page.getByText("Тагов пока нет").first()).toBeVisible();

  await page.request.post(`/api/projects/${project.code}/tags`, { data: { name: "нось" } });
  await page.reload();
  await page.getByRole("button", { name: "Переименовать" }).click();
  const input = page.getByLabel("Новое имя тага «нось»");
  await input.fill("ночь");
  await input.press("Enter");
  await expect(page.getByText("ночь", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Удалить таг «ночь»" }).click();
  await expect(page.getByText("Тагов пока нет").first()).toBeVisible();
});
