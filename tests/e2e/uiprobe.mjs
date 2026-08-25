/** Смотрим глазами браузера: что на самом деле применилось к элементам.
 *
 * Проверять стили «на слово» уже дважды оказывалось ошибкой. Здесь берутся
 * вычисленные значения — то, что реально нарисует движок.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://frontend";
const LOGIN = "tester";
const PASSWORD = "123456";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// Вход через API той же вкладки: сессия у них общая.
await page.goto(BASE + "/");
const ok = await page.evaluate(async ([login, password]) => {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: login, password }),
  });
  return r.status;
}, [LOGIN, PASSWORD]);
console.log("вход:", ok);

// Заводим проект и таску, чтобы было на что смотреть.
const code = await page.evaluate(async () => {
  const tag = "test-ui-" + Math.random().toString(16).slice(2, 8);
  const p = await (await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: tag, description: "проба" }),
  })).json();
  return p.code;
});
console.log("проект:", code);

// --- пустой раздел тасок ---
await page.goto(`${BASE}/projects/${code}/tasks`);
await page.waitForSelector(".mag-empty-big", { timeout: 15000 });
const empty = await page.$eval(".mag-empty-big", (el) => {
  const cs = getComputedStyle(el);
  const kids = [...el.children].map((k) => {
    const r = k.getBoundingClientRect();
    return { tag: k.tagName, top: Math.round(r.top), bottom: Math.round(r.bottom) };
  });
  const gaps = kids.slice(1).map((k, i) => k.top - kids[i].bottom);
  return { display: cs.display, gap: cs.rowGap, kids: kids.length, gaps };
});
console.log("заглушка:", JSON.stringify(empty));
await page.screenshot({ path: "/tmp/ui-empty.png" });

// --- таска и её подразделы ---
const taskId = await page.evaluate(async (code) => {
  const t = await (await fetch(`/api/projects/${code}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "проба вкладок" }),
  })).json();
  return t.id;
}, code);
await page.goto(`${BASE}/projects/${code}/tasks/${taskId}`);
await page.waitForSelector(".mag-tabs .mag-tab", { timeout: 15000 });

const tabs = await page.$$eval(".mag-tabs .mag-tab", (els) =>
  els.map((el) => {
    const cs = getComputedStyle(el);
    return {
      текст: el.textContent.trim().slice(0, 22),
      фон: cs.backgroundColor,
      рамка: cs.borderTopWidth + " " + cs.borderTopColor,
      низ: cs.borderBottomWidth + " " + cs.borderBottomColor,
      цвет: cs.color,
      шрифт: cs.fontSize + "/" + cs.fontFamily.split(",")[0],
    };
  })
);
tabs.forEach((t) => console.log("вкладка:", JSON.stringify(t)));

// --- заглушка «нет кадров» внутри таски ---
const inner = await page.$eval(".g-empty", (el) => {
  const cs = getComputedStyle(el);
  const kids = [...el.childNodes].filter((n) => n.nodeType === 1).length;
  return { display: cs.display, gap: cs.rowGap, kids };
}).catch(() => null);
console.log("заглушка в таске:", JSON.stringify(inner));

// --- фон страницы и карточки: контраст ---
const surfaces = await page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const card = document.querySelector(".mag-card");
  return {
    paper: root.getPropertyValue("--paper").trim(),
    card: root.getPropertyValue("--card").trim(),
    фонКарточки: card ? getComputedStyle(card).backgroundColor : null,
    фонСтраницы: getComputedStyle(document.body).backgroundColor,
  };
});
console.log("поверхности:", JSON.stringify(surfaces));

await page.screenshot({ path: "/tmp/ui-task.png", fullPage: true });
await browser.close();
console.log("снимки: /tmp/ui-empty.png, /tmp/ui-task.png");
