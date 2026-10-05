/** Проба редизайна: «Участники» и меню обзора глазами браузера. Только смотрит — ничего не отправляет. */
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
  return r.projects.filter((p) => !p.name.startsWith("test-")).sort((a, b) => b.members_count - a.members_count)[0].code;
});
console.log("проект:", code);

await page.goto(`${BASE}/projects/${code}/members`);
await page.waitForSelector(".mem-tbl", { timeout: 20000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/m-table.png` });
console.log("строк:", await page.locator(".mem-tbl tbody tr").count());

const invite = page.getByRole("button", { name: "Пригласить" });
if (await invite.count()) {
  await invite.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/m-invite.png` });
  await page.keyboard.press("Escape");
}
const roleSel = page.locator(".mem-tbl td:nth-child(2) .ui-select").first();
if (await roleSel.count()) {
  await roleSel.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/m-role.png` });
  await page.keyboard.press("Escape");
}

await page.goto(`${BASE}/projects/${code}`);
await page.getByRole("button", { name: "Действия с проектом" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/m-menu.png` });
await page.keyboard.press("Escape");

console.log("ошибки:", errors.length ? errors : "нет");
await browser.close();
