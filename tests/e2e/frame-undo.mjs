// Настоящий AnnotationEditor: Ctrl+Z только на своём кадре, шаги SAM2 и точек контура.
// API и SAM2 подменены, рабочие данные не трогаются.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const base = process.env.BASE || 'http://127.0.0.1:5181';
const out = new URL('./test-results/frame-undo/', import.meta.url);
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
const project = { id: 'project', code: 'test', name: 'Отмена по кадрам', status: 'ready', created_at: '2026-11-27T09:00:00Z' };
const puts = [];
let predicts = 0;
let srv = 0;
try {
  await mkdir(out, { recursive: true });
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (/\/(file|thumb|preview)$/.test(path)) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><path fill="#647080" d="M0 0H800V500H0Z"/></svg>' });
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 'me', display_name: 'Проверка' }, projects: [{ ...project, role: 'admin', role_label: 'Админ' }] } });
    if (path === '/api/projects/test/classes') return route.fulfill({ json: { classes: [
      { id: 'wagon', class_index: 0, name: 'Вагон', color: '#f0bd58', superclass_id: null, superclass_name: null, annotations: 0 },
    ], superclasses: [], can_edit: true, can_manage: true } });
    const ann = /^\/api\/images\/(image-\d)\/annotations$/.exec(path);
    if (ann && req.method() === 'PUT') {
      const body = req.postDataJSON();
      puts.push({ image: ann[1], boxes: body.boxes, undo: !!body.undo });
      return route.fulfill({ json: { saved: body.boxes.length, clamped: 0, task_status: body.boxes.length ? 'annotated' : 'new', rev: ++srv,
        shapes: body.boxes.map((b, i) => ({ id: b.id ?? `srv-${srv}-${i}`, source: b.source ?? 'human', pending: false })) } });
    }
    if (path === '/api/auto/sessions' && req.method() === 'POST') return route.fulfill({ json: { session_id: 'sam' } });
    if (path === '/api/auto/sessions/sam/warm') return route.fulfill({ json: { ok: true } });
    if (path === '/api/auto/sessions/sam/predict') {
      predicts += 1;
      const n = req.postDataJSON().prompts?.points?.length ?? 0;
      const w = 40 + n * 30;
      return route.fulfill({ json: { shapes: [{ type: 'box', score: 0.9, box: { x: 380, y: 230, w, h: 60 },
        polygons: [[[380, 230], [380 + w, 230], [380 + w, 290], [380, 290]]] }], width: 800, height: 500 } });
    }
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' });
    return route.fulfill({ json: { classes: [], boxes: [], agents: [], mappings: {}, runs: [], questions: [], events: [], rev: null } });
  });
  await page.route('**/frame-undo-test*', (route) => route.fulfill({ contentType: 'text/html', body: `
    <html lang="ru"><meta charset="utf-8"><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { BrowserRouter } = await import('/node_modules/.vite/deps/react-router-dom.js');
    const { default: AuthGate } = await import('/src/components/auth/AuthGate.tsx');
    const { default: Editor } = await import('/src/components/mag/AnnotationEditor.tsx');
    for (const file of ['common','editor','video','tokens','ui','layout','editor-ui']) await import('/src/styles/' + file + '.css');
    const h = React.createElement, noop = () => {};
    const start = [0, 1, 2].map((i) => ({ id: 'image-' + i, task_status: i ? 'new' : 'annotated', file_name: 'Кадр ' + i, width: 800, height: 500,
      rev: 1, annotations: i ? 0 : 1, tag_ids: [],
      boxes: i ? [] : [{ id: 'a', class_index: 0, x: 100, y: 100, w: 200, h: 150, source: 'human', name: 'Вагон', color: '#f0bd58' }] }));
    function Fixture() {
      const [index, setIndex] = React.useState(0), [images, setImages] = React.useState(start);
      window.testState = { index, images };
      return h(Editor, { code: 'test', scope: { kind: 'task', taskId: 'test', taskName: 'Отмена' }, images, index,
        readOnly: false, tags: [], people: [], canTag: false, onIndex: setIndex, onClose: noop,
        onChanged: (id, patch) => setImages((list) => list.map((im) => (im.id === id ? { ...im, ...patch } : im))),
        onTags: noop, onTagCreated: noop });
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(BrowserRouter, null, h(AuthGate, null, h(Fixture))));
    </script></html>` }));

  await page.goto(base + '/frame-undo-test');
  await page.waitForFunction(() => document.querySelector('.mag-cv-frame img')?.naturalWidth > 0);
  await expect.poll(() => page.locator('.mag-cv-frame').evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(500);
  const at = async (x, y) => { const f = await page.locator('.mag-cv-frame').boundingBox(); return { x: f.x + x / 800 * f.width, y: f.y + y / 500 * f.height }; };
  const click = async (x, y, mods = []) => {
    const p = await at(x, y);
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.click(p.x, p.y);
    for (const m of mods.reverse()) await page.keyboard.up(m);
  };
  const index = () => page.evaluate(() => window.testState.index);
  const boxesOf = (i) => page.evaluate((i) => window.testState.images[i].boxes.length, i);
  const putsOf = (image) => puts.filter((p) => p.image === image);
  const settle = () => page.waitForTimeout(900);
  const pts = () => page.locator('.mag-cv-pt').count();
  const draft = () => page.locator('.mag-cv-draft .mag-cv-v').count();
  const preview = () => page.locator('.mag-cv-pre').count();
  const previewW = () => page.locator('.mag-cv-pre rect').evaluate((r) => Math.round(Number(r.getAttribute('width'))));

  // --- 1. Отмена только на своём кадре ---------------------------------------- #
  await click(200, 175);
  await page.keyboard.press('Delete');
  await expect.poll(() => putsOf('image-0').at(-1)?.boxes.length).toBe(0);
  await page.keyboard.press('ArrowRight');
  await expect.poll(index).toBe(1);
  const before = puts.length;
  await page.keyboard.press('Control+KeyZ');
  await settle();
  expect(await index(), 'Ctrl+Z на чужом кадре не уводит назад').toBe(1);
  expect(puts.length, 'и ничего не записывает').toBe(before);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(index).toBe(0);
  await page.keyboard.press('Control+KeyZ');
  await expect.poll(() => putsOf('image-0').at(-1)).toMatchObject({ undo: true, boxes: [{ x: 100, w: 200 }] });
  await expect.poll(() => boxesOf(0)).toBe(1);
  await page.keyboard.press('Control+Shift+KeyZ');
  await expect.poll(() => putsOf('image-0').at(-1)?.boxes.length).toBe(0);
  await page.screenshot({ path: fileURLToPath(new URL('1-own-frame.png', out)) });

  // --- 2. Точки и выделение SAM2 — шаги отмены -------------------------------- #
  await page.keyboard.press('ArrowRight');
  await expect.poll(index).toBe(1);
  await expect(page.getByRole('button', { name: 'Полуавтомат SAM2', exact: true })).toBeEnabled();
  await page.keyboard.press('KeyA');
  await expect(page.getByRole('button', { name: 'Полуавтомат SAM2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await click(400, 250);
  await expect.poll(preview).toBe(1);
  expect(await pts()).toBe(1);
  const w1 = await previewW();
  await click(450, 260, ['Shift']);
  await expect.poll(pts).toBe(2);
  await expect.poll(previewW).toBeGreaterThan(w1);
  expect(predicts).toBe(2);
  await page.keyboard.press('Control+KeyZ');
  await expect.poll(pts, 'отмена снимает последнюю точку').toBe(1);
  await expect.poll(previewW, 'и возвращает прежнее выделение').toBe(w1);
  await page.keyboard.press('Control+KeyZ');
  await expect.poll(pts).toBe(0);
  await expect.poll(preview, 'первая точка снята — выделения нет').toBe(0);
  await page.keyboard.press('Control+Shift+KeyZ');
  await expect.poll(preview).toBe(1);
  expect(await pts()).toBe(1);
  expect(await previewW()).toBe(w1);
  expect(predicts, 'повтор берёт выделение из снимка, без нового запроса').toBe(2);
  await page.screenshot({ path: fileURLToPath(new URL('2-sam-redo.png', out)) });

  const putsBefore = putsOf('image-1').length;
  await page.keyboard.press('Space');
  await expect.poll(() => putsOf('image-1').length).toBeGreaterThan(putsBefore);
  await expect.poll(() => putsOf('image-1').at(-1)?.boxes.length).toBe(1);
  await expect.poll(preview).toBe(0);
  await page.keyboard.press('Control+KeyZ');
  await expect.poll(() => putsOf('image-1').at(-1)).toMatchObject({ undo: true, boxes: [] });
  await expect.poll(preview, 'отмена закрепления возвращает выделение').toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(preview).toBe(0);
  await page.keyboard.press('Control+KeyZ');
  await expect.poll(preview, 'сброс Esc тоже отменяется').toBe(1);
  // Ушли с кадра с выделением и вернулись: брошенное выделение отменой не воскресает
  await page.keyboard.press('ArrowRight');
  await expect.poll(index).toBe(2);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(index).toBe(1);
  expect(await preview()).toBe(0);
  const putsBack = puts.length;
  await page.keyboard.press('Control+KeyZ');
  await page.keyboard.press('Control+Shift+KeyZ');
  await settle();
  expect(await preview()).toBe(0);
  expect(await pts()).toBe(0);
  expect(puts.length).toBe(putsBack);

  // --- 3. Точки контура: отмена и повтор -------------------------------------- #
  await page.keyboard.press('KeyA');
  await expect(page.getByRole('button', { name: 'Полуавтомат SAM2', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('KeyP');
  await click(500, 100); await click(650, 120); await click(600, 220);
  await expect.poll(draft).toBe(3);
  await page.keyboard.press('Control+KeyZ');
  await expect.poll(draft).toBe(2);
  await page.keyboard.press('Control+KeyY');
  await expect.poll(draft, 'повтор возвращает снятую точку').toBe(3);
  await page.keyboard.press('Control+Shift+KeyZ');
  await settle();
  expect(await draft(), 'возвращать больше нечего').toBe(3);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+KeyZ');
  await expect.poll(draft).toBe(0);
  await page.keyboard.press('Control+Shift+KeyZ');
  await expect.poll(draft, 'и после снятия всех точек').toBe(1);
  await page.keyboard.press('Control+KeyY'); await page.keyboard.press('Control+KeyY');
  await expect.poll(draft).toBe(3);
  await page.keyboard.press('Enter');
  await expect.poll(() => putsOf('image-1').at(-1)?.boxes[0]?.parts?.[0]?.length).toBe(3);
  await page.keyboard.press('Control+KeyZ');
  await expect.poll(() => putsOf('image-1').at(-1)).toMatchObject({ undo: true, boxes: [] });
  await page.screenshot({ path: fileURLToPath(new URL('3-polygon.png', out)) });

  expect(errors, errors.join('\n')).toEqual([]);
  console.log(`frame-undo: ok, записей ${puts.length}, запросов SAM2 ${predicts}`);
} catch (e) {
  if (errors.length) console.log('Ошибки страницы:\n' + errors.join('\n---\n'));
  await page.screenshot({ path: fileURLToPath(new URL('fail.png', out)) }).catch(() => {});
  throw e;
} finally {
  await browser.close();
}
