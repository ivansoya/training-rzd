/** Проба редизайна: «Проекты» и «Датасеты» глазами браузера (скриншоты в test-results). */
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

await page.goto(BASE + "/");
await page.waitForSelector(".pcard", { timeout: 20000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/g-projects.png` });

const code = await page.evaluate(async () => {
  const r = await (await fetch("/api/projects")).json();
  return r.projects.filter((p) => !p.code.startsWith("TEST")).sort((a, b) => b.images_count - a.images_count)[0].code;
});
console.log("проект:", code);

await page.goto(`${BASE}/projects/${code}/datasets`);
await page.waitForSelector(".fr-tile", { timeout: 20000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/g-datasets.png` });
console.log("плиток в DOM:", await page.locator(".fr-tile").count());

await page.getByRole("button", { name: /^Классы/ }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/g-classes-pop.png` });
await page.locator(".fr-opts .ui-check-l").first().click();
await page.keyboard.press("Escape");
await page.waitForTimeout(800);
await page.getByRole("button", { name: "Подписи" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/g-filtered.png` });

// Прокрутка — виртуализация держит в DOM только видимые ряды
await page.getByRole("button", { name: "Сбросить" }).click();
await page.waitForTimeout(1000);
await page.locator(".fr-gh .ui-btn[aria-label='Действия с группой']").first().click();
await page.getByRole("button", { name: /Показать все/ }).click();
await page.waitForTimeout(2500);
await page.evaluate(() => document.querySelector(".shell-main").scrollBy(0, 3000));
await page.waitForTimeout(500);
console.log("после «показать все» и прокрутки, плиток в DOM:", await page.locator(".fr-tile").count());
await page.screenshot({ path: `${OUT}/g-scrolled.png` });

await page.evaluate(() => document.querySelector(".shell-main").scrollTo(0, 0));
await page.locator(".fr-gt").first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/g-collapsed.png` });
await page.locator(".fr-gt").first().click();
await page.waitForTimeout(500);

await page.locator(".fr-tile:not(.fr-more)").first().click();
await page.waitForSelector(".lbx", { timeout: 10000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/g-lightbox.png` });
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(600);
console.log("счётчик:", await page.locator(".lbx-h .ui-mono.t-xs").first().textContent());
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
console.log("лайтбокс закрыт:", (await page.locator(".lbx").count()) === 0);

// Ссылка на датасет: его группа раскрыта, прочие свёрнуты
const ds = await page.evaluate(async (code) => (await (await fetch(`/api/projects/${code}`)).json()).datasets, code);
await page.goto(`${BASE}/projects/${code}/datasets?ds=${ds[ds.length - 1].id}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/g-ds-link.png` });

// Поиск кадра Ctrl K → ссылка на кадр открывает просмотр
await page.keyboard.press("Control+k");
await page.keyboard.type("011_varan");
await page.waitForSelector("text=Кадры", { timeout: 5000 });
await page.screenshot({ path: `${OUT}/g-search.png` });
await page.keyboard.press("ArrowDown");
const opt = page.getByRole("option").filter({ hasText: "011_varan" }).first();
await opt.click();
await page.waitForSelector(".lbx", { timeout: 10000 });
console.log("кадр по ссылке:", page.url().includes("frame="), await page.locator(".lbx-name").textContent());
await page.getByRole("button", { name: "Разметить" }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/g-lightbox-edit.png` });
await page.getByRole("button", { name: "Готово" }).click();
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
console.log("после закрытия адрес без frame:", !page.url().includes("frame="));

console.log("ошибки:", errors.length ? errors : "нет");
await browser.close();
