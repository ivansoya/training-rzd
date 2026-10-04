/** Проба редизайна: «Классы» и «Таги» глазами браузера. Только смотрит — ничего не сохраняет и не удаляет. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5173";
const OUT = "/work/tests/e2e/test-results";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(BASE + "/");
console.log("вход:", await page.evaluate(async () => (await fetch("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
})).status));

const code = await page.evaluate(async () => {
  const r = await (await fetch("/api/projects")).json();
  return r.projects.filter((p) => !p.name.startsWith("test-")).sort((a, b) => b.images_count - a.images_count)[0].code;
});
console.log("проект:", code);

await page.goto(`${BASE}/projects/${code}/classes`);
await page.waitForSelector("tr.cls-row", { timeout: 20000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/c-table.png` });
console.log("строк:", await page.locator("tr.cls-row").count());

// Класс с разметкой — панель и раскрытая судьба (без подтверждения)
const busy = page.locator("tr.cls-row").filter({ hasNot: page.locator("td:nth-child(4) .t-faint") }).first();
await busy.click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/c-panel.png` });
await page.locator(".cls-side").getByRole("button", { name: "Удалить класс" }).click();
await page.waitForTimeout(600);
await page.locator(".cls-side").getByRole("combobox", { name: "Куда перенести" }).click();
await page.getByRole("option").nth(1).click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/c-fate.png`, fullPage: false });
await page.locator(".cls-side").getByRole("button", { name: "Не удалять" }).click();

await page.locator(".cls-side").getByRole("radio", { name: "Свой цвет" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/c-color.png` });
await page.keyboard.press("Escape");

await page.getByRole("button", { name: "Все группы" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/c-groups.png` });
await page.keyboard.press("Escape");

await page.goto(`${BASE}/projects/${code}/tags`);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/c-tags.png` });

console.log("ошибки:", errors.length ? errors : "нет");
await browser.close();
