/** Окно «Образцы класса» и меню ручной рамки на превью глазами браузера. Только смотрит:
 *  окно закрывается «Отменой», в меню ничего не выбирается.
 *
 *   docker exec -w /work/tests/e2e -e AGENT=<id> -e PROJECT=<код> -e BASE=http://host.docker.internal:5174 \
 *     -e NODE_PATH=/opt/e2e/node_modules yolo-tests node examplepickprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const AGENT = process.env.AGENT;
const CARD = process.env.CARD || "Металлический";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
await page.goto(BASE + "/");
await page.evaluate(([agent, project]) => {
  localStorage.setItem(`agent-preview:${agent}`, JSON.stringify({ project }));
  return fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "tester", password: "VniiTest" }) });
}, [AGENT, process.env.PROJECT]);
await page.goto(`${BASE}/agents/${AGENT}`);
await page.waitForSelector(".ge-flow .ge-node", { timeout: 30000 });
await page.locator(".ge-node", { has: page.locator(".ge-node-t", { hasText: "SAM 3" }) }).click();
await page.waitForSelector(".ae-frame img", { timeout: 90000 }).catch(() => console.log("  превью не пришло"));

// Окно из меню карточки
const card = page.locator(".ae-card", { has: page.locator(".ae-card-n b", { hasText: CARD }) }).first();
// Докрутить заранее: прокрутка во время щелчка закрывает всплывашку (так устроен Popover).
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await card.locator(".ae-card-h button[aria-label^='Ещё']").click();
await page.locator(".ui-pop").getByText("Выбрать образцы…").click();
await page.waitForSelector(".ep-tile", { timeout: 30000 }).catch(() => console.log("  плиток нет"));
await page.waitForTimeout(2500);
console.log("плиток:", await page.locator(".ep-tile").count(), "| в наборе:", await page.locator(".ep-th").count(),
  "| подпись:", await page.locator(".ep-tools .t-xs").innerText().catch(() => "—"));
await page.screenshot({ path: `${OUT}/pick-1.png` });

await page.locator(".ep-flag").click();
await page.waitForTimeout(500);
console.log("плиток без склейки похожих:", await page.locator(".ep-tile").count());
await page.getByRole("button", { name: /Случайно \+\d+ разных/ }).click();
await page.waitForTimeout(3000);
console.log("в наборе после «Случайно»:", await page.locator(".ep-th").count(),
  "| проходы:", (await page.locator(".ep-pass-h").allInnerTexts()).join(" / "));
const col = page.locator(".ep-col-pic img");
console.log("коллаж:", (await col.count()) ? "есть" : await page.locator(".ep-col-pic").innerText());
await page.screenshot({ path: `${OUT}/pick-2.png` });
// Плитка «+1» до заполнения прохода, затем «+ проход»
await page.getByRole("button", { name: "Очистить" }).click();
const plus = page.locator(".ep .ep-add");
let clicks = 0;
while (clicks < 30 && (await plus.innerText()).includes("+1") && await plus.isEnabled()) { await plus.click(); clicks++; }
console.log("«+1» нажата:", clicks, "| в наборе:", await page.locator(".ep-th").count(), "| теперь плитка:", (await plus.innerText()).replace(/\s+/g, " "));
await page.screenshot({ path: `${OUT}/pick-4.png` });
await plus.click();
await page.waitForTimeout(300);
console.log("после «+ проход»: в наборе", await page.locator(".ep-th").count(), "| проходы:", (await page.locator(".ep-pass-h span:first-child").allInnerTexts()).join(", "));
await page.locator(".ep-side").screenshot({ path: `${OUT}/pick-5.png` });
await page.getByRole("button", { name: "Отмена" }).click();
await page.waitForTimeout(400);

// Меню ручной рамки на кадре превью: правая кнопка по центру первой белой рамки
const human = await page.evaluate(() => {
  const frame = document.querySelector(".ae-frame");
  const r = frame?.getBoundingClientRect();
  const rect = [...document.querySelectorAll(".ae-frame svg rect, .ae-frame svg path")]
    .map((el) => el.getBoundingClientRect()).find((b) => b.width > 4 && b.height > 4 && r && b.left >= r.left);
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
});
if (human) {
  await page.mouse.click(human.x, human.y, { button: "right" });
  await page.waitForTimeout(400);
  console.log("меню рамки:", (await page.locator(".ae-hmenu").innerText().catch(() => "нет")).replace(/\n/g, " | "));
  await page.screenshot({ path: `${OUT}/pick-3.png` });
  await page.keyboard.press("Escape");
} else console.log("ручных рамок на кадре не нашёл");
await browser.close();
