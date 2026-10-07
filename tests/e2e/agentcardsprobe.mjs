/** Редактор агента глазами браузера: вариант А, карточки классов, «Развернуть». Только смотрит —
 *  ничего не печатает и не сохраняет.
 *
 *   docker exec -w /work/tests/e2e -e AGENT=<id> -e PROJECT=<код> -e BASE=http://host.docker.internal:5174 \
 *     -e NODE_PATH=/opt/e2e/node_modules yolo-tests node agentcardsprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const TAG = process.env.TAG || "";
const AGENT = process.env.AGENT;

const browser = await chromium.launch();
const W = Number(process.env.W || 1600), H = Number(process.env.H || 1000);
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("  консоль:", m.text()));
await page.goto(BASE + "/");
await page.evaluate(
  ([agent, project]) => {
    localStorage.setItem(`agent-preview:${agent}`, JSON.stringify({ project }));
    return fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: "tester", password: "VniiTest" }),
    });
  },
  [AGENT, process.env.PROJECT]
);

await page.goto(`${BASE}/agents/${AGENT}`);
await page.waitForSelector(".ge-flow .ge-node", { timeout: 30000 });
await page.waitForSelector(".ae-frame img", { timeout: 90000 }).catch(() => console.log("  превью не пришло"));
console.log("сайдбар приложения:", await page.locator("aside.sb").count(), "| полоса значков:", await page.locator(".ae-rail-i").count());
await page.screenshot({ path: `${OUT}/${TAG}cards-a0.png` });

const node = (title) => page.locator(".ge-node", { has: page.locator(".ge-node-t", { hasText: title }) });
await node("SAM 3").click();
await page.waitForTimeout(2500);
console.log("карточек:", await page.locator(".ae-card").count(), "| сводки:",
  (await page.locator(".ae-card-sum").allInnerTexts()).join(" | "));
await page.screenshot({ path: `${OUT}/${TAG}cards-a1-sam3.png` });

await node("SAM 3").dblclick();
await page.waitForSelector(".ae-chain");
await page.waitForTimeout(800);
console.log("цепочка:", (await page.locator(".ae-cn").allInnerTexts()).map((t) => t.replace(/\n/g, " ")).join(" › "));
await page.screenshot({ path: `${OUT}/${TAG}cards-b-sam3.png` });

await page.locator(".ae-cn", { hasText: "YOLOE" }).first().click();
await page.waitForTimeout(1500);
console.log("YOLOE: на кадре —", (await page.locator(".ae-got").allInnerTexts()).join(", "));
const first = page.locator(".ae-pl input.ui-mono").first();
if (await first.count()) {
  await first.focus();
  await page.waitForTimeout(300);
  console.log("подсказка:", await page.locator(".ae-under").first().innerText().catch(() => "нет"));
}
await page.screenshot({ path: `${OUT}/${TAG}cards-b-yoloe.png` });

await page.locator(".ae-chain").click({ position: { x: 900, y: 10 } });
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
console.log("после Esc развёрнуто:", await page.locator(".ae-chain").count());
await page.screenshot({ path: `${OUT}/${TAG}cards-a2-yoloe.png` });
await browser.close();
