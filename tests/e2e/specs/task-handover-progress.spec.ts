import { test, expect } from "@playwright/test";
import { signIn, tag } from "../helpers";

test("обзор таски показывает ход сдачи, восстанавливает его и сообщает итог", async ({ page }) => {
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  const task = await (await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });
  let processed = 30;
  let status = "running";
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(),
      status: status === "done" ? "done" : "in_progress", handover: status === "running" ? "handover-test" : null } });
  });
  await page.route("**/api/jobs/handover-test", (route) => route.fulfill({ json: {
    id: "handover-test", type: "task-handover", status, processed, total: 120,
    message: "Достаю кадры роликов", result: status === "done" ? { accepted: 120 } : null,
    error: status === "error" ? "Сдать таску не удалось." : null,
  } }));
  const url = `/projects/${project.code}/tasks/${task.id}`;
  await page.goto(url);
  const progress = page.getByRole("status").filter({ hasText: "Сдача таски" });
  await expect(progress).toBeVisible({ timeout: 5000 });
  await expect(progress).toContainText("Достаю кадры роликов");
  await expect(progress).toContainText("30 из 120");
  await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  processed = 90;
  await expect(progress).toContainText("90 из 120");
  await page.reload();
  await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "75");
  processed = 120;
  await expect(progress).toContainText("Завершаю сдачу");
  // Обработаны все кадры, но транзакция ещё не завершена: индикатор остаётся.
  await expect(progress).toBeVisible();
  await page.screenshot({ path: "/work/design-mockups/2026-11-06-handover-progress/progress.png", fullPage: true });
  status = "done";
  await expect(progress).toHaveCount(0);
  await expect(page.locator(".tp-pass").getByText("Готово", { exact: true }).first()).toBeVisible();
  // Повторное открытие работающей сдачи и ошибка не должны оставлять вечный прогресс.
  status = "running"; processed = 0;
  await page.goto(url);
  await expect(progress).toBeVisible();
  status = "error";
  await expect(page.getByText("Сдать таску не удалось.", { exact: true })).toBeVisible();
  await expect(progress).toHaveCount(0);
});
