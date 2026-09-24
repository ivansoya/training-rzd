/** Плашка решений в окне кадра — глазами браузера.
 *
 * Смотрит: на плашке нужные кнопки и «Далее →», в шапке их больше нет;
 * плашка стоит по центру окна кадра, а не всего редактора; в покое кнопки
 * полупрозрачны и у плашки нет фона, на наведении фон есть. Ничего не
 * нажимает — разметка таски не меняется.
 *
 *   docker exec -w /work/tests/e2e -e TASK=/projects/<код>/tasks/<id> \
 *     -e NODE_PATH=/opt/e2e/node_modules yolo-tests node framebarprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
await page.goto(BASE + "/");
await page.evaluate(() =>
  fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "123456" }),
  })
);

await page.goto(BASE + process.env.TASK);
await page.getByRole("button", { name: "Размечать" }).first().click();
await page.waitForSelector(".mag-ed-vbar", { timeout: 30000 });
await page.waitForTimeout(1200);

const bar = page.locator(".mag-ed-vbar");
console.log("кадр:", await page.locator(".mag-ed-cnt").innerText(),
  "| пометка:", (await page.locator(".mag-ed-flag").allInnerTexts()).join(", ") || "нет");
console.log("на плашке:", (await bar.locator("button").allInnerTexts()).join(" · "));
console.log("в шапке «Далее»:", await page.locator(".mag-ed-head", { hasText: "Далее" }).count());

const geometry = await page.evaluate(() => {
  const b = document.querySelector(".mag-ed-vbar").getBoundingClientRect();
  const cv = document.querySelector(".mag-ed-view .mag-cv").getBoundingClientRect();
  return {
    centerShift: Math.round((b.left + b.width / 2) - (cv.left + cv.width / 2)),
    fromBottom: Math.round(cv.bottom - b.bottom),
  };
});
console.log("сдвиг от центра окна кадра, px:", geometry.centerShift, "| от низа:", geometry.fromBottom);

const look = () => page.evaluate(() => {
  const b = document.querySelector(".mag-ed-vbar");
  const btn = b.querySelector("button");
  return { фон: getComputedStyle(b).backgroundColor, прозрачность: getComputedStyle(btn).opacity };
});
await page.mouse.move(5, 500);
await page.waitForTimeout(400);
console.log("в покое:", JSON.stringify(await look()));
await page.screenshot({ path: `${OUT}/framebar-rest.png` });
await bar.hover();
await page.waitForTimeout(400);
console.log("на наведении:", JSON.stringify(await look()));
await page.screenshot({ path: `${OUT}/framebar-hover.png` });
await browser.close();
