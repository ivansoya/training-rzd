// Настоящий AnnotationEditor: фильтр «С открытыми вопросами» вместе со статусами. API подменён.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const base = process.env.BASE || 'http://127.0.0.1:5181';
const out = new URL('./test-results/frame-question-filter/', import.meta.url);
const shot = (name) => page.screenshot({ path: fileURLToPath(new URL(name, out)) });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
const project = { id: 'project', code: 'test', name: 'Вопросы', status: 'ready', created_at: '2026-11-27T09:00:00Z' };
try {
  await mkdir(out, { recursive: true });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (/\/(file|thumb|preview)$/.test(path)) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><path fill="#647080" d="M0 0H800V500H0Z"/></svg>' });
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 'me', display_name: 'Проверка' }, projects: [{ ...project, role: 'admin', role_label: 'Админ' }] } });
    if (path === '/api/projects/test/classes') return route.fulfill({ json: { classes: [
      { id: 'wagon', class_index: 0, name: 'Вагон', color: '#f0bd58', superclass_id: null, superclass_name: null, annotations: 0 },
    ], superclasses: [], can_edit: true, can_manage: true } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' });
    return route.fulfill({ json: { classes: [], boxes: [], agents: [], mappings: {}, runs: [], questions: [], events: [], rev: null } });
  });
  await page.route('**/question-filter-test*', (route) => route.fulfill({ contentType: 'text/html', body: `
    <html lang="ru"><meta charset="utf-8"><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { BrowserRouter } = await import('/node_modules/.vite/deps/react-router-dom.js');
    const { default: AuthGate } = await import('/src/components/auth/AuthGate.tsx');
    const { default: Editor } = await import('/src/components/mag/AnnotationEditor.tsx');
    for (const file of ['common','editor','video','tokens','ui','layout','editor-ui']) await import('/src/styles/' + file + '.css');
    const h = React.createElement, noop = async () => {};
    const statuses = ['new', 'annotated', 'annotated', 'new', 'empty'];
    const images = statuses.map((task_status, i) => ({ id: 'image-' + i, task_status, file_name: (i + 1) + '.jpg', width: 800, height: 500,
      rev: 1, annotations: 0, tag_ids: [], boxes: [] }));
    const q = (id, image, status, by_agent = false) => ({ id, status, by_agent, place: image, image_id: image, video_id: null, frame_no: null,
      time_ms: null, object_id: null, object_kind: null, object_gone: false, class: null, author: 'Проверка', author_id: 'me',
      created_at: '2026-11-27T09:00:00Z', last_at: '2026-11-27T09:00:00Z', resolved_by: null, resolved_at: null, can_settle: true,
      messages: [{ id: id + '-m', text: 'Что это?', author: 'Проверка', author_id: 'me', created_at: '2026-11-27T09:00:00Z' }] });
    // Открытые — на кадрах 2 и 4 (второй от агента), закрытый — на 3
    const list = [q('q1', 'image-1', 'open'), q('q2', 'image-2', 'resolved'), q('q3', 'image-3', 'open', true)];
    const questions = { list, canAsk: true, error: null, ask: async () => null, reply: noop, edit: noop, remove: noop,
      resolve: noop, reopen: noop, drop: noop, read: () => {}, reload: noop };
    function Fixture() {
      const [index, setIndex] = React.useState(0);
      window.testIndex = index;
      return h(Editor, { code: 'test', scope: { kind: 'task', taskId: 'test', taskName: 'Вопросы' }, images, index,
        readOnly: false, tags: [], people: [], canTag: false, onIndex: setIndex, onClose: () => {}, onChanged: () => {},
        onTags: () => {}, onTagCreated: () => {}, questions });
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(BrowserRouter, null, h(AuthGate, null, h(Fixture))));
    </script></html>` }));

  await page.goto(base + '/question-filter-test');
  await page.waitForFunction(() => document.querySelector('.mag-cv-frame img')?.naturalWidth > 0);
  const cells = page.locator('.fe-film .mag-fs-cell:not(.out)');
  const visible = () => cells.evaluateAll((items) => items.map((item) => item.title.split(' — ')[0]));
  await expect.poll(visible).toEqual(['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg']);

  await page.getByRole('button', { name: 'Фильтр', exact: true }).click();
  const asked = page.getByRole('group', { name: 'Вопросы' });
  await expect(asked.locator('.ui-count')).toHaveText('2');
  await asked.getByRole('checkbox', { name: /С открытыми вопросами/ }).check();
  // Текущий кадр 1 остаётся в ленте до ухода с него, но помечен как не по фильтру
  await expect.poll(visible, 'открытые вопросы, закрытый не считается').toEqual(['2.jpg', '4.jpg']);
  await expect(page.locator('.fe-flt .fr-fcount')).toHaveText('2');
  await shot('1-asked.png');

  // Сочетается со статусом через «и»
  await page.getByRole('group', { name: 'Статус кадра' }).getByRole('checkbox', { name: 'Размеченные' }).check();
  await expect.poll(visible).toEqual(['2.jpg']);
  await page.getByRole('group', { name: 'Статус кадра' }).getByRole('checkbox', { name: 'Размеченные' }).uncheck();
  await page.keyboard.press('Escape');

  // Переходы идут только по отобранным
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.testIndex)).toBe(1);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.testIndex)).toBe(3);

  await page.getByRole('button', { name: 'Фильтр', exact: true }).click();
  await page.locator('.flt-pop').getByRole('button', { name: 'Сбросить' }).click();
  await expect.poll(visible).toEqual(['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg']);
  expect(errors, errors.join('\n')).toEqual([]);
  console.log('frame-question-filter: ok');
} catch (e) {
  if (errors.length) console.log('Ошибки страницы:\n' + errors.join('\n---\n'));
  await shot('fail.png').catch(() => {});
  throw e;
} finally {
  await browser.close();
}
