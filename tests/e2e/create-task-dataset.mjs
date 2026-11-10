// Настоящее окно создания таски с подменённым API: имя нового датасета и выбор существующего.
// Запуск при работающем Vite: node tests/e2e/create-task-dataset.mjs
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = process.env.BASE || "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const code = "CREATETASKDATASET0001";
const project = { id: "project", code, name: "Искра", status: "ready" };
const datasets = [{ id: "existing", name: "Первый набор от настоящих камер", images_count: 120 }];
const submitted = [];
let failNext = false;

try {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    let data;
    if (path === "/api/auth/me") data = {
      user: { id: "me", display_name: "Соя Иван", login: "check", hardware: null },
      projects: [{ ...project, role: "admin", role_label: "Администратор" }],
    };
    else if (path === `/api/projects/${code}`) data = {
      project, my_role: "admin", members: [{ id: "me", display_name: "Соя Иван", role: "admin" }],
      datasets, classes: [],
      stats: { images: 120, annotations: 0, size_bytes: 0, datasets: datasets.length, classes: 0, tasks: 0 },
    };
    else if (path === `/api/projects/${code}/tasks`) {
      if (route.request().method() === "POST") {
        submitted.push(route.request().postDataJSON());
        if (failNext) {
          failNext = false;
          return route.fulfill({ status: 400, json: { error: "Не удалось создать таску. Повторите попытку." } });
        }
        return route.fulfill({ status: 201, json: { id: `created-${submitted.length}` } });
      }
      data = { tasks: [], can_create: true, is_admin: true };
    }
    else if (path === "/api/friends") data = { friends: [], incoming: [], outgoing: [] };
    else if (path === "/api/invitations") data = { invitations: [] };
    else if (path === "/api/tasks/questions-inbox") data = { items: [], total: 0 };
    else return route.fulfill({ status: 503, json: { error: "Unavailable in create-task check" } });
    return route.fulfill({ json: data });
  });
  const dialog = page.getByRole("dialog", { name: "Новая таска" });
  const taskName = dialog.getByLabel("Название таски", { exact: true });
  const datasetName = dialog.getByLabel("Название нового датасета", { exact: true });
  const target = dialog.getByRole("combobox", { name: "Датасет для готовых кадров" });
  const create = dialog.getByRole("button", { name: "Создать и загрузить кадры" });
  const open = async () => {
    await page.goto(`${base}/projects/${code}/tasks`);
    await page.getByRole("button", { name: "Новая таска" }).click();
    await expect(dialog).toBeVisible();
  };
  const choose = async (name) => {
    await target.click();
    await page.getByRole("option", { name }).click();
  };
  const created = async () => {
    await expect(page).toHaveURL(new RegExp(`/tasks/created-${submitted.length}$`));
  };

  await open();
  await expect(datasetName).toBeVisible({ timeout: 2000 });
  await expect(taskName).toBeFocused();
  await expect(create).toBeDisabled();
  await taskName.fill("Проверка камер");
  await expect(datasetName).toHaveAttribute("placeholder", "Проверка камер");
  await expect(datasetName).toHaveAttribute("maxlength", "255");
  await datasetName.fill("  Кадры Искры за ноябрь  ");
  await taskName.fill("  Проверка камер 9 ноября  ");
  await expect(datasetName).toHaveValue("  Кадры Искры за ноябрь  ");
  await choose("Первый набор от настоящих камер");
  await expect(datasetName).toHaveCount(0);
  await choose("Новый датасет");
  await expect(datasetName).toHaveValue("  Кадры Искры за ноябрь  ");
  await mkdir(new URL("./test-results/", import.meta.url), { recursive: true });
  await dialog.screenshot({ path: fileURLToPath(new URL("./test-results/create-task-dataset.png", import.meta.url)) });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(create).toBeInViewport();
  expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
  await dialog.screenshot({ path: fileURLToPath(new URL("./test-results/create-task-dataset-mobile.png", import.meta.url)) });
  failNext = true;
  await create.click();
  await expect(dialog).toContainText("Не удалось создать таску. Повторите попытку.");
  await expect(datasetName).toHaveValue("  Кадры Искры за ноябрь  ");
  await datasetName.press("Enter");
  await created();
  expect(submitted.at(-1)).toMatchObject({ name: "Проверка камер 9 ноября", target_dataset_id: null, target_dataset_name: "Кадры Искры за ноябрь" });

  await page.setViewportSize({ width: 1280, height: 900 });
  await open();
  await taskName.fill("Имя по умолчанию");
  await datasetName.fill("   ");
  await create.click();
  await created();
  expect(submitted.at(-1)).toMatchObject({ name: "Имя по умолчанию", target_dataset_id: null, target_dataset_name: null });

  await open();
  await taskName.fill("Добавление в существующий");
  await datasetName.fill("Не должно отправляться");
  await choose("Первый набор от настоящих камер");
  await expect(datasetName).toHaveCount(0);
  await create.click();
  await created();
  expect(submitted.at(-1)).toMatchObject({ target_dataset_id: "existing", target_dataset_name: null });

  datasets.length = 0;
  await open();
  await taskName.fill("Первый датасет проекта");
  await datasetName.fill("Отдельное имя");
  await create.click();
  await created();
  expect(submitted.at(-1)).toMatchObject({ target_dataset_id: null, target_dataset_name: "Отдельное имя" });
  expect(errors).toEqual([]);
  console.log("PASS: своё имя, имя таски по умолчанию, существующий датасет, пустой проект, сохранение ввода после ошибки, Enter и узкий экран");
} catch (error) {
  console.error("Browser errors:", errors);
  console.error("Page:", await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
