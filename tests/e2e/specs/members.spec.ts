import { expect, test } from "@playwright/test";
import { signIn, tag } from "../helpers";

/**
 * «Участники»: приглашение друга флажком и по логину, отзыв, смена роли в строке,
 * исключение; настройки проекта — в меню «⋯» обзора.
 */

test("участники: приглашения, роль и исключение", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const admin = await signIn(page);
  const ctx = await browser.newContext();
  const friendPage = await ctx.newPage();
  const friend = await signIn(friendPage);

  // Встречные заявки делают друзьями
  expect((await page.request.post("/api/friends", { data: { identity: friend } })).ok()).toBeTruthy();
  expect((await friendPage.request.post("/api/friends", { data: { identity: admin } })).ok()).toBeTruthy();

  const name = tag();
  const project = await (await page.request.post("/api/projects", { data: { name } })).json();
  await page.goto(`/projects/${project.code}/members`);
  await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible();
  await expect(page.locator(".mem-tbl tbody tr")).toHaveCount(1);

  // Друг — флажком, с ролью «Просмотр»
  await page.getByRole("button", { name: "Пригласить" }).click();
  const dialog = page.getByRole("dialog", { name: "Пригласить в проект" });
  await dialog.locator(".np-friends li", { hasText: friend }).getByRole("checkbox").check();
  await dialog.getByRole("combobox", { name: /^Роль: / }).click();
  await page.getByRole("option", { name: /Просмотр/ }).click();
  await dialog.getByRole("button", { name: "Пригласить" }).click();
  await expect(dialog).toBeHidden();
  // Логин приглашённого сервер не раскрывает — строка приглашения одна
  const pending = page.locator("tr.mem-inv");
  await expect(pending).toContainText("Просмотр");
  await expect(page.getByText("Ждут ответа · 1")).toBeVisible();

  // Отозвали — друг снова доступен в окне
  await pending.getByRole("button", { name: "Отозвать" }).click();
  await expect(pending).toHaveCount(0);

  // По логину — тот же человек, редактором по умолчанию
  await page.getByRole("button", { name: "Пригласить" }).click();
  await dialog.getByLabel("Логин или почта").fill(friend);
  await dialog.getByRole("button", { name: "Пригласить" }).click();
  await expect(dialog).toBeHidden();
  await expect(pending).toContainText("Редактор");

  const inv = (await (await friendPage.request.get("/api/invitations")).json()).invitations;
  const iid = inv.find((i: { project: { code: string } }) => i.project.code === project.code).id;
  expect((await friendPage.request.post(`/api/invitations/${iid}/accept`)).ok()).toBeTruthy();
  await page.reload();

  const row = page.locator(".mem-tbl tbody tr:not(.mem-inv):not(.mem-sub)", { hasText: friend });
  await expect(row).toContainText("не размечал(а)");
  await row.getByRole("combobox").click();
  await page.getByRole("option", { name: /Администратор/ }).click();
  await expect.poll(async () => {
    const d = await (await page.request.get(`/api/projects/${project.code}`)).json();
    return d.members.find((m: { login: string }) => m.login === friend)?.role;
  }).toBe("admin");

  // Поиск сужает таблицу
  await page.getByLabel("Найти участника").fill(friend);
  await expect(page.locator(".mem-tbl tbody tr")).toHaveCount(1);
  await page.getByLabel("Найти участника").fill("");

  await row.getByRole("button", { name: /^Исключить/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Исключить" }).click();
  await expect(row).toHaveCount(0);

  // Настройки — в меню обзора
  await page.goto(`/projects/${project.code}`);
  await page.getByRole("button", { name: "Действия с проектом" }).click();
  await page.getByRole("button", { name: "Настройки проекта…" }).click();
  const settings = page.getByRole("dialog", { name: "Настройки проекта" });
  await settings.getByLabel("Название").fill(`${name} новое`);
  await settings.getByRole("button", { name: "Сохранить" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator(".ui-ph")).toContainText(`${name} новое`);
  await ctx.close();
});
