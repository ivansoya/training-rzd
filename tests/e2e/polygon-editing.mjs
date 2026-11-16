// Настоящий общий BoxCanvas, локальная React-оболочка без API и записи разметки.
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = process.env.BASE || "http://127.0.0.1:5181";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const out = new URL("./test-results/polygon-editing/", import.meta.url);

try {
  await mkdir(out, { recursive: true });
  await page.route("**/polygon-editing-test", (route) => route.fulfill({ contentType: "text/html", body: `
    <html lang="ru"><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = ReactDOM;
    const { default: BoxCanvas } = await import('/src/components/mag/BoxCanvas.tsx');
    await import('/src/styles/editor.css');
    const h = React.createElement;
    function Fixture() {
      const [boxes, setBoxes] = React.useState([]), [tool, setTool] = React.useState('polygon');
      const [selected, setSelected] = React.useState(null), [selectedPart, setPart] = React.useState(null);
      const [splitParts, setSplit] = React.useState(false);
      const ref = React.useRef(null);
      window.fixture = { boxes, selected, setBoxes, setTool, setSelected, setPart, setSplit, ref };
      return h('div', { style: { display: 'flex', height: 800 } }, h(BoxCanvas, {
        ref, imageId: 'test', src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><path fill="#5a6b7a" d="M0 0H800V500H0Z"/></svg>'),
        width: 800, height: 500, boxes, tool, selected, selectedPart, splitParts,
        editable: true, activeClass: 0, labels: false,
        labelOf: () => ({ name: 'Вагон', color: '#f0bd58' }),
        onSelect: (i, part) => { setSelected(i); setPart(part ?? null); }, onBoxes: setBoxes,
        onPolygon: (ring) => setBoxes((b) => [...b, { class_index: 0, kind: 'polygon', x: 0, y: 0, w: 800, h: 500, parts: [ring] }]),
      }));
    }
    createRoot(document.getElementById('root')).render(h(Fixture));
    </script></html>` }));
  await page.goto(`${base}/polygon-editing-test`);
  await expect(page.locator(".mag-cv")).toHaveAttribute('aria-busy', 'false');
  await page.waitForFunction(() => document.querySelector('.mag-cv-frame img')?.naturalWidth > 0 && window.fixture);
  // Даём decode() и ResizeObserver подготовить редактируемый кадр.
  await expect.poll(() => page.locator('.mag-cv-frame').evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(500);
  const frame = () => page.locator('.mag-cv-frame').boundingBox();
  const at = async (x, y) => { const f = await frame(); return { x: f.x + x / 800 * f.width, y: f.y + y / 500 * f.height }; };
  const move = async (x, y) => { const p = await at(x, y); await page.mouse.move(p.x, p.y); };
  const click = async (x, y) => { const p = await at(x, y); await page.mouse.click(p.x, p.y); };
  const parts = () => page.evaluate(() => window.fixture.boxes[0]?.parts.map((r) => r.map((p) => p.map((n) => Math.round(n * 1000) / 1000))));
  const reset = async (rings = [[[100, 100], [600, 100], [600, 400], [100, 400]]]) => {
    await page.evaluate((rings) => {
      const f = window.fixture;
      f.ref.current.cancelPolygon(); f.ref.current.fit(); f.setTool('select'); f.setSelected(0); f.setPart(null); f.setSplit(false);
      f.setBoxes([{ class_index: 0, kind: 'polygon', x: 100, y: 100, w: 500, h: 300, parts: rings }]);
    }, rings);
    await expect(page.locator('.mag-cv-v')).toHaveCount(rings.flat().length);
  };

  // Превью и реально сохранённые клики должны одинаково упираться во все четыре края.
  for (const scale of [1, 0.8]) {
    await page.evaluate((scale) => { const f = window.fixture; f.setBoxes([]); f.setTool('polygon'); f.ref.current.fit(); f.ref.current.zoomBy(scale); }, scale);
    await click(100, 100);
    for (const [x, y, expected] of [[-8, 180, [0, 180]], [808, 220, [800, 220]], [350, -20, [350, 0]], [450, 520, [450, 500]]]) {
      await move(x, y);
      const preview = await page.locator('.mag-cv-draft .mag-cv-line').getAttribute('d');
      const f = await frame(), stage = await page.locator('.mag-cv').boundingBox();
      const nums = preview.match(/[-\d.]+/g).map(Number);
      expect(nums.at(-2), 'Резинка ограничена кадром по X').toBeCloseTo(f.x - stage.x + expected[0] / 800 * f.width, 1);
      expect(nums.at(-1), 'Резинка ограничена кадром по Y').toBeCloseTo(f.y - stage.y + expected[1] / 500 * f.height, 1);
      await click(x, y);
    }
    await page.keyboard.press('Enter');
    await expect.poll(parts).toEqual([[[100, 100], [0, 180], [800, 220], [350, 0], [450, 500]]]);
  }
  console.log('PASS: draft preview and placement clamp to all frame boundaries at two zoom levels');
  if (process.env.BOUNDS_ONLY) {
    expect(errors).toEqual([]);
  } else {
    await reset();
    await move(270, 108);
    await page.keyboard.down('Alt');
    // Alt после наведения тоже немедленно показывает вставку.
    await expect(page.locator('.mag-cv-new')).toHaveCount(1);
    await page.screenshot({ path: fileURLToPath(new URL('edge-preview.png', out)) });
    await click(270, 108);
    await expect.poll(parts).toEqual([[[100, 100], [270, 100], [600, 100], [600, 400], [100, 400]]]);
    await page.keyboard.up('Alt');
    await reset();
    // Клик без промежуточного pointermove вычисляет место заново, а не использует старое превью.
    await page.locator('.mag-cv').dispatchEvent('pointerdown', { button: 0, altKey: true, pointerId: 1,
      clientX: (await at(420, 105)).x, clientY: (await at(420, 105)).y });
    await page.mouse.up();
    await expect.poll(parts).toEqual([[[100, 100], [420, 100], [600, 100], [600, 400], [100, 400]]]);
    await reset();
    await page.keyboard.down('Alt');
    await move(270, 108);
    await page.mouse.down();
    await page.keyboard.up('Alt');
    await move(300, -20);
    await page.mouse.up();
    await expect.poll(parts).toEqual([[[100, 100], [300, 0], [600, 100], [600, 400], [100, 400]]]);
    // Далеко от контура и на существующей вершине точка не добавляется и выделение не пропадает.
    await reset();
    await page.keyboard.down('Alt');
    await move(350, 250);
    await expect(page.locator('.mag-cv-new')).toHaveCount(0);
    await click(350, 250);
    await click(100, 100);
    await expect(page.locator('.mag-cv-v')).toHaveCount(4);
    expect(await page.evaluate(() => window.fixture.selected)).toBe(0);
    await page.keyboard.up('Alt');
    // Та же зона захвата в экранных пикселях после зума; обычный drag остаётся ограничен кадром.
    await page.evaluate(() => window.fixture.ref.current.zoomBy(1.5));
    await expect.poll(async () => (await frame()).width).toBeGreaterThan(1600);
    await page.keyboard.down('Alt');
    const p = await at(270, 100);
    await page.mouse.move(p.x, p.y + 8);
    await expect(page.locator('.mag-cv-new')).toHaveCount(1);
    await page.keyboard.up('Alt');
    await move(100, 100); await page.mouse.down(); await move(-30, 160); await page.mouse.up();
    await expect.poll(async () => (await parts())[0][0][0]).toBe(0);
    // Ограничение выбранной частью: ближайшая чужая грань не перехватывает вставку.
    await reset([[[100, 100], [300, 100], [300, 400], [100, 400]], [[500, 100], [700, 100], [700, 400], [500, 400]]]);
    await page.evaluate(() => { window.fixture.setSplit(true); window.fixture.setPart(0); });
    await page.keyboard.down('Alt'); await click(600, 105); await page.keyboard.up('Alt');
    expect((await parts()).map((r) => r.length)).toEqual([4, 4]);
    await move(200, 105); await page.keyboard.down('Alt');
    await expect(page.locator('.mag-cv-new')).toHaveCount(1);
    await page.mouse.move(1250, 850);
    await expect(page.locator('.mag-cv-new')).toHaveCount(0);
    await page.keyboard.up('Alt');
    expect(errors).toEqual([]);
    console.log('PASS: explicit edge insertion, immediate drag, stale preview, far click, vertex deduplication, zoom, selected part, pointer leave');
  }
} catch (e) { console.error({ errors, state: await page.evaluate(() => ({ selected: window.fixture?.selected, boxes: window.fixture?.boxes, frame: document.querySelector('.mag-cv-frame')?.getBoundingClientRect().toJSON(), stage: document.querySelector('.mag-cv')?.getBoundingClientRect().toJSON() })) }); throw e; }
finally { await browser.close(); }
