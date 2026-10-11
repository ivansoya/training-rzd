/** Окно «на карте не запустится» глазами tester (решения 11.10.2026): «Запустить» в окне обучения при
 *  карте, ужатой запасом, открывает окно с причиной сервера, подсказкой входа и тремя кнопками; «Поставить
 *  вход …» возвращает в форму с поправленным полем. Обучение не запускается. Карту ужимает и
 *  возвращает тот, кто зовёт пробу (SQL до и после) — сама проба базы не трогает.
 *
 *   docker exec -w /work/tests/e2e -e PASS=123456 -e PROJECT=<код> -e NODE_PATH=/opt/e2e/node_modules yolo-tests node cpuprobe.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const PROJECT = process.env.PROJECT || "";

const bad = [];
const check = (ok, what) => { console.log(`${ok ? "OK  " : "FAIL"} ${what}`); if (!ok) bad.push(what); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => bad.push(`ошибка страницы: ${e.message}`));
await page.goto(BASE + "/");
await page.evaluate((pass) => fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identity: "tester", password: pass }) }), process.env.PASS || "VniiTest");
await page.goto(`${BASE}/projects/${PROJECT}/runs`);
await page.getByRole("button", { name: "Новое обучение" }).first().click();
const form = page.getByRole("dialog", { name: "Новое обучение" });
await form.waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);   // наборы и модели грузятся
const imgsz = form.getByLabel("Размер входа");
const before = await imgsz.inputValue();
await form.getByRole("button", { name: "Запустить" }).click();

const ask = page.getByRole("dialog", { name: "На карте не запустится" });
await ask.waitFor({ timeout: 20000 });
await page.waitForTimeout(700);   // анимация появления
// Окно поверх формы: непрозрачно, и в середине предупреждения — оно само, а не поле формы под ним.
const top = await ask.evaluate((el) => {
  const note = el.querySelector(".ui-notice, [role=alert], [class*=notice]") || el;
  const r = note.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { opacity: getComputedStyle(el).opacity, inside: el.contains(hit) };
});
check(top.opacity === "1", `окно непрозрачно (opacity ${top.opacity})`);
check(top.inside, "середина предупреждения — в окне, а не в форме под ним");
const text = (await ask.innerText()).replace(/\s+/g, " ");
console.log("окно:", text);
check(/Не поместится на карту: нужно [\d,]+ ГБ/.test(text), "причина сервера с числами");
check(/На карту влезет вход до \d+ при батче 1/.test(text), "подсказка входа");
check(!/медлен|раз быстрее|в \d+ раз/.test(text), "про скорость ничего");
for (const name of ["Отменить", "Запустить на процессоре"]) {
  check(await ask.getByRole("button", { name }).count() === 1, `кнопка «${name}»`);
}
const fit = ask.getByRole("button", { name: /^Поставить вход \d+, батч 1$/ });
check(await fit.count() === 1, "кнопка «Поставить вход …»");
await page.screenshot({ path: `${OUT}/cpu-ask.png` });
const want = (await fit.innerText()).match(/\d+/)[0];
await fit.click();
await page.waitForTimeout(300);
check(await ask.count() === 0, "окно закрылось");
check(await form.count() === 1, "форма обучения осталась открытой");
check(await imgsz.inputValue() === want && want !== before, `поле входа стало ${want} (было ${before})`);
check(await form.getByLabel("Батч").inputValue() === "1", "батч стал 1");
await page.screenshot({ path: `${OUT}/cpu-fit.png` });
await browser.close();
console.log(bad.length ? `ИТОГ: ${bad.length} FAIL\n- ${bad.join("\n- ")}` : "ИТОГ: всё OK");
process.exit(bad.length ? 1 : 0);
