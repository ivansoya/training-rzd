import { defineConfig, devices } from "@playwright/test";

/** Браузер ходит в тот же nginx, что и человек: отдельного стенда нет, и
 *  проверяется ровно то, что открыто в соседней вкладке.
 *
 *  Единственная поправка — адрес. Разжатие кадров держится на WebCodecs, а он
 *  доступен только в защищённом контексте: HTTPS или localhost. Стенд отвечает
 *  по http на имя контейнера, поэтому рядом поднимается проброс на localhost
 *  (см. `forward.mjs`), и уже он ведёт в тот же nginx. В настоящей работе
 *  вместо этого нужен HTTPS. */
const LOCAL_PORT = Number(process.env.TEST_LOCAL_PORT || 8099);
const origin = `http://localhost:${LOCAL_PORT}`;

export default defineConfig({
  testDir: "./specs",
  // Тесты трогают общую базу — параллелить их значит ловить чужие данные.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  webServer: {
    command: "node forward.mjs",
    url: origin,
    reuseExistingServer: true,
    timeout: 20_000,
  },
  use: {
    baseURL: origin,
    // Скриншот и трасса только на упавшем: на зелёном прогоне это мусор.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
