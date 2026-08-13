import { defineConfig, devices } from "@playwright/test";

/** Браузер ходит в тот же nginx, что и человек: отдельного стенда нет, и
 *  проверяется ровно то, что открыто в соседней вкладке. */
export default defineConfig({
  testDir: "./specs",
  // Тесты трогают общую базу — параллелить их значит ловить чужие данные.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.TEST_BASE_URL || "http://frontend",
    // Скриншот и трасса только на упавшем: на зелёном прогоне это мусор.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
