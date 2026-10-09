/** «Влезет ли агент на карту» глазами браузера: плашка и «Ресурсы» в редакторе агента,
 *  «Слов за проход» у SAM 3, окно запуска с группами и вердиктом. Только смотрит: ничего не
 *  сохраняет и не запускает — окна закрываются «Отменой».
 *
 *   docker exec -w /work/tests/e2e -e AGENT=<id> -e TASK=<id> -e PROJECT=<код> \
 *     -e NODE_PATH=/opt/e2e/node_modules yolo-tests node agentfitprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const { AGENT, TASK, PROJECT } = process.env;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
await page.goto(BASE + "/");
await page.evaluate(() => fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: "VniiTest" }) }));

// Редактор агента: плашка в шапке и окно «Ресурсы»
await page.goto(`${BASE}/agents/${AGENT}`);
await page.waitForSelector(".ge-flow .ge-node", { timeout: 30000 });
await page.waitForSelector("button.ae-vd", { timeout: 30000 }).catch(() => console.log("  плашки нет"));
console.log("плашка:", (await page.locator(".ae-vd").first().innerText()).replace(/\s+/g, " "));
await page.screenshot({ path: `${OUT}/fit-1-head.png`, clip: { x: 0, y: 0, width: 1600, height: 80 } });
await page.locator("button.ae-vd").click();
await page.waitForSelector(".ae-res", { timeout: 5000 });
await page.waitForTimeout(600);
console.log("ресурсы:", (await page.locator(".ae-res").innerText()).replace(/\s+/g, " ").slice(0, 400));
await page.screenshot({ path: `${OUT}/fit-2-res.png` });
await page.keyboard.press("Escape");

// Узел SAM 3: «Слов за проход» и «Память узла»
const sam = page.locator(".ge-node", { has: page.locator(".ge-node-t", { hasText: "SAM 3" }) }).first();
if (await sam.count()) {
  await sam.click();
  await page.waitForTimeout(800);
  console.log("слов за проход:", await page.getByText("Слов за проход").count() ? "есть" : "нет",
    "| память узла:", (await page.locator(".ae-panel-row", { hasText: "Память узла" }).innerText().catch(() => "—")).replace(/\s+/g, " "));
  await page.locator(".ae-insp").screenshot({ path: `${OUT}/fit-3-node.png` });
  const sel = page.getByRole("combobox", { name: "Слов за проход" });
  if (await sel.count() && await sel.isEnabled()) {
    await sel.click();
    await page.waitForTimeout(400);
    console.log("варианты:", (await page.locator(".ui-select-pop").innerText()).replace(/\s+/g, " "));
    await page.screenshot({ path: `${OUT}/fit-3-words.png` });
    await page.keyboard.press("Escape");
  }
} else console.log("  узла SAM 3 нет");

// Окно запуска на таске
if (TASK && PROJECT) {
  await page.goto(`${BASE}/projects/${PROJECT}/tasks/${TASK}`);
  await page.waitForTimeout(2500);
  await page.keyboard.press("g");
  await page.getByRole("button", { name: "Разметить агентом…" }).click({ timeout: 10000 }).catch(() => console.log("  нет «Разметить агентом…»"));
  await page.waitForSelector(".ar", { timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  console.log("подвал:", (await page.locator(".ui-dialog-f").last().innerText()).replace(/\s+/g, " "));
  await page.getByRole("combobox", { name: "Агент" }).click().catch(() => undefined);
  await page.waitForTimeout(400);
  console.log("агенты:", (await page.locator(".ui-select-pop").innerText().catch(() => "—")).replace(/\s+/g, " "));
  await page.screenshot({ path: `${OUT}/fit-4-run.png` });
}
await browser.close();
