/** Файлы мышью в таску (решения 27.10.2026) глазами браузера: зоны пустой таски и род файлов, гаснет без броска,
 *  ролики в очередь, смесь над заполненной таской (наложение), изображения частями по 200, «нельзя» у закрытой.
 *  Бросок синтетический: DataTransfer из скрипта, папку так не бросить — её разворот проверяется руками.
 *  Заводит проект test-drop-…, в конце удаляет. Снимки — в OUT.
 *
 *   docker exec -w /work/tests/e2e -e NODE_PATH=/opt/e2e/node_modules yolo-tests node dropprobe.mjs
 */
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://host.docker.internal:5173";
const OUT = process.env.OUT || "/work/tests/e2e/test-results";
const SAMPLE = readFileSync(process.env.SAMPLE || "/tmp/magistral-sample-30f.mp4").toString("base64");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("  ошибка страницы:", e.message));
const api = page.request;
await page.goto(BASE + "/");
for (const password of [process.env.PASS, "VniiTest", "123456"].filter(Boolean)) {
  if ((await api.post(`${BASE}/api/auth/login`, { data: { identity: "tester", password } })).status() === 200) break;
}
const made = async (res) => {
  if (res.status() >= 300) throw new Error(`${res.url()} → ${res.status()} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};
const project = await made(await api.post(`${BASE}/api/projects`, { data: { name: `test-drop-${Date.now() % 100000}`, description: "", invites: [] } }));
const task = await made(await api.post(`${BASE}/api/projects/${project.code}/tasks`, { data: { name: "Проба перетаскивания" } }));
// Прокси vite на стенде изредка теряет запрос — опрос переживает одиночный обрыв
const getTask = async () => {
  for (let k = 0; ; k++) {
    try { return await (await api.get(`${BASE}/api/tasks/${task.id}`, { timeout: 8000 })).json(); } catch (e) { if (k === 3) throw e; }
  }
};

/** Над элементом тащат файлы: dragover каждые 100 мс, как у живого перетаскивания. Цель ищется заново — наложение
 *  появляется после первого же dragover. Файлы собираются в странице: ролики — образец, изображения — разные PNG. */
async function hover(selector, want) {
  await page.evaluate(async ([sel, want, sample]) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(sample), (c) => c.charCodeAt(0));
    for (let i = 0; i < (want.videos || 0); i++) dt.items.add(new File([bytes], `ролик-${i + 1}.mp4`, { type: "video/mp4" }));
    for (let i = 0; i < (want.images || 0); i++) {
      const c = new OffscreenCanvas(8, 8);
      const g = c.getContext("2d");
      g.fillStyle = "#336"; g.fillRect(0, 0, 8, 8);
      g.fillStyle = `rgb(${i & 255},${i >> 8},200)`; g.fillRect(0, 0, 2, 2);
      dt.items.add(new File([await c.convertToBlob({ type: "image/png" })], `кадр-${i + 1}.png`, { type: "image/png" }));
    }
    for (let i = 0; i < (want.text || 0); i++) dt.items.add(new File(["заметка"], `заметка-${i + 1}.txt`, { type: "text/plain" }));
    window.__dt = dt;
    const at = () => document.querySelector(sel) || document.body;
    const fire = (type) => at().dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    clearInterval(window.__drag);
    fire("dragenter");
    fire("dragover");
    window.__drag = setInterval(() => fire("dragover"), 100);
  }, [selector, want, SAMPLE]);
  await page.waitForTimeout(400);
}
const dropOn = (selector) => page.evaluate((sel) => {
  clearInterval(window.__drag);
  document.querySelector(sel).dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
}, selector);
const letGo = () => page.evaluate(() => clearInterval(window.__drag));
const ways = (scope = "") => page.$$eval(`${scope} .tp-way`, (els) => els.map((e) =>
  `${e.querySelector("b").textContent}: ${["on", "fit", "off"].find((c) => e.classList.contains(c)) || "—"} «${e.querySelector(".tp-way-say")?.textContent || ""}»`));
const wait = async (what, ok, secs = 60) => {
  for (let t = 0; t < secs * 2; t++) { if (await ok()) return true; await page.waitForTimeout(500); }
  console.log(`  не дождался: ${what}`);
  return false;
};

try {
  await page.goto(`${BASE}/projects/${project.code}/tasks/${task.id}`);
  await page.waitForSelector(".tp-empty .tp-way", { timeout: 30000 });
  console.log("1. покой — строк «перетащите»:", await page.locator(".tp-way-dnd").count());
  await page.screenshot({ path: `${OUT}/drop-1-idle.png` });

  await hover(".tp-empty .tp-way:nth-child(1)", { images: 2 });
  console.log("2. тащат 2 изображения:", (await ways()).join(" | "));
  await page.screenshot({ path: `${OUT}/drop-2-images.png` });
  await letGo();
  await page.waitForTimeout(700);
  console.log("   ушли без броска — зон в состоянии:", await page.locator(".tp-way.on, .tp-way.fit, .tp-way.off").count());

  await hover(".tp-empty .tp-way:nth-child(2)", { videos: 2 });
  console.log("3. тащат 2 ролика:", (await ways()).join(" | "));
  await dropOn(".tp-empty .tp-way:nth-child(2)");
  await wait("два ролика на нарезку", async () => (await getTask()).videos.filter((v) => v.mode === "cut").length === 2);
  console.log("   на нарезку легло:", (await getTask()).videos.filter((v) => v.mode === "cut").map((v) => v.file_name).join(", "));

  await page.waitForSelector(".tp-src", { timeout: 30000 });
  await hover(".tp-veil .tp-way:nth-child(3)", { videos: 1, images: 1, text: 1 });
  console.log("4. смесь над заполненной — наложение:", await page.locator(".tp-veil").count(), "|", (await ways(".tp-veil")).join(" | "));
  await page.screenshot({ path: `${OUT}/drop-3-veil.png` });
  await dropOn(".tp-veil .tp-way:nth-child(3)");
  await page.waitForTimeout(300);
  console.log("   плашка:", await page.locator(".ui-notice, [role=status]").first().innerText().catch(() => "нет"));
  await wait("ролик на разметку", async () => (await getTask()).videos.some((v) => v.mode === "annotate"));

  await hover(".tp-veil .tp-way:nth-child(1)", { images: 450 });
  await dropOn(".tp-veil .tp-way:nth-child(1)");
  await page.waitForSelector(".mag-up", { timeout: 15000 });
  console.log("5. окно тагов:", (await page.locator(".mag-up .mag-sub").innerText()).replace(/\s+/g, " "));
  await hover("body", { images: 1 });
  console.log("   поверх окна наложений:", await page.locator(".tp-veil").count());
  await letGo();
  await page.locator(".mag-up .mag-btn").click();
  const seen = new Set();
  await wait("450 изображений", async () => {
    const line = await page.locator(".tp-upload-l").innerText().catch(() => "");
    if (line) seen.add(line.replace(/ · \d+ %$/, "").replace(/\s+/g, " "));
    if (seen.size === 2) await page.screenshot({ path: `${OUT}/drop-4-parts.png` });
    return ((await getTask()).sources?.files?.frames || 0) >= 450;
  }, 180);
  console.log("   строки очереди:", [...seen].join(" | "));
  console.log("   изображений в таске:", (await getTask()).sources?.files?.frames);

  const closed = await api.post(`${BASE}/api/tasks/${task.id}/status`, { data: { status: "closed" } });
  console.log("6. закрыть таску:", closed.status());
  await wait("таска закрыта", async () => (await getTask()).status === "closed" && !(await getTask()).handover, 120);
  await page.reload();
  await page.waitForSelector(".tp-src", { timeout: 30000 });
  await hover("body", { videos: 1 });
  console.log("   закрытая:", (await page.locator(".tp-veil.no .tp-nope").innerText().catch(() => "нет плашки")).replace(/\n/g, " | "));
  await page.screenshot({ path: `${OUT}/drop-5-no.png` });
  await letGo();
} finally {
  console.log("проект удалён:", (await api.delete(`${BASE}/api/projects/${project.code}`)).status());
  await browser.close();
}
