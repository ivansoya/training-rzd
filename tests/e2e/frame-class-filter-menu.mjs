// Настоящий AnnotationEditor: меню фильтра не закрывается от галочки класса, кнопки «Исключить все / Добавить все». API подменён.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const base = process.env.BASE || 'http://127.0.0.1:5181';
const out = new URL('./test-results/frame-class-filter-menu/', import.meta.url);
const shot = (name) => page.screenshot({ path: fileURLToPath(new URL(name, out)) });
const errors = [];
const puts = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
const project = { id: 'project', code: 'test', name: 'Классы', status: 'ready', created_at: '2026-11-27T09:00:00Z' };
try {
  await mkdir(out, { recursive: true });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (/\/(file|thumb|preview)$/.test(path)) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><path fill="#647080" d="M0 0H800V500H0Z"/></svg>' });
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 'me', display_name: 'Проверка' }, projects: [{ ...project, role: 'admin', role_label: 'Админ' }] } });
    if (path === '/api/projects/test/classes') return route.fulfill({ json: { classes: [
      { id: 'wagon', class_index: 0, name: 'Вагон', color: '#f0bd58', superclass_id: null, superclass_name: null, annotations: 0 },
      { id: 'man', class_index: 1, name: 'Человек', color: '#5aa9e6', superclass_id: null, superclass_name: null, annotations: 0 },
      { id: 'sign', class_index: 2, name: 'Знак', color: '#8bd17c', superclass_id: null, superclass_name: null, annotations: 0 },
    ], superclasses: [], can_edit: true, can_manage: true } });
    if (/^\/api\/images\/image-\d+\/annotations$/.test(path) && route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      puts.push(body.boxes);
      return route.fulfill({ json: { saved: body.boxes.length, clamped: 0, task_status: 'annotated', rev: puts.length + 1,
        shapes: body.boxes.map((b) => ({ id: b.id, source: b.source ?? 'human', pending: !!b.pending })) } });
    }
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' });
    return route.fulfill({ json: { classes: [], boxes: [], agents: [], mappings: {}, runs: [], questions: [], events: [], rev: null } });
  });
  await page.route('**/class-filter-menu-test*', (route) => route.fulfill({ contentType: 'text/html', body: `
    <html lang="ru"><meta charset="utf-8"><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { BrowserRouter } = await import('/node_modules/.vite/deps/react-router-dom.js');
    const { default: AuthGate } = await import('/src/components/auth/AuthGate.tsx');
    const { default: Editor } = await import('/src/components/mag/AnnotationEditor.tsx');
    for (const file of ['common','editor','video','tokens','ui','layout','editor-ui']) await import('/src/styles/' + file + '.css');
    const h = React.createElement;
    // 80 кадров: класс по кругу, лента длинная — смена отбора двигает её прокрутку
    // На текущем кадре 41 — рамка агента на проверке
    const agent = { source: 'model', pending: true, conf: 0.8, agent: { id: 'yolo', name: 'YOLO', version: 1 } };
    const images = Array.from({ length: 80 }, (_, i) => ({ id: 'image-' + i, task_status: i === 40 ? 'new' : 'annotated',
      file_name: (i + 1) + '.jpg', width: 800, height: 500, rev: 1, annotations: 1, tag_ids: [],
      boxes: [{ id: 'b' + i, class_index: i % 3, x: 100, y: 100, w: 200, h: 150, source: 'human', name: '', color: '#f0bd58',
        ...(i === 40 ? agent : {}) }] }));
    function Fixture() {
      const [index, setIndex] = React.useState(40);
      window.testIndex = index;
      return h(Editor, { code: 'test', scope: { kind: 'task', taskId: 'test', taskName: 'Классы' }, images, index,
        readOnly: false, tags: [], people: [], canTag: false, onIndex: setIndex, onClose: () => {}, onChanged: () => {},
        onTags: () => {}, onTagCreated: () => {} });
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(BrowserRouter, null, h(AuthGate, null, h(Fixture))));
    </script></html>` }));

  await page.goto(base + '/class-filter-menu-test');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.mag-cv-frame img')?.naturalWidth > 0);
  const count = page.locator('.fe-flt .fr-fcount');

  await page.getByRole('button', { name: 'Фильтр', exact: true }).click();
  const pop = page.locator('.flt-pop');
  const classes = pop.getByRole('group', { name: 'Классы' });
  await expect(pop).toBeVisible();

  // Галочка класса — меню остаётся открытым, можно снять следующую
  await classes.getByRole('checkbox', { name: /Человек/ }).uncheck();
  await page.waitForTimeout(300);
  await expect(pop, 'меню закрылось после галочки класса').toBeVisible();
  await classes.getByRole('checkbox', { name: /Знак/ }).uncheck();
  await page.waitForTimeout(300);
  await expect(pop).toBeVisible();
  await expect(count).toHaveText('27');
  await shot('1-two-off.png');

  // Все классы разом: часть снята — «Добавить все», все отмечены — «Исключить все»
  await expect(pop.getByRole('button', { name: 'Исключить все' })).toHaveCount(0);
  await pop.getByRole('button', { name: 'Добавить все' }).click();
  await expect(pop).toBeVisible();
  await expect(classes.getByRole('checkbox', { checked: false })).toHaveCount(0);
  await expect(count).toHaveCount(0);
  await pop.getByRole('button', { name: 'Исключить все' }).click();
  await expect(pop).toBeVisible();
  await expect(classes.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(page.locator('.fe-film-none')).toBeVisible();
  await shot('2-none.png');
  await pop.getByRole('button', { name: 'Добавить все' }).click();
  await expect(pop).toBeVisible();
  await expect(classes.getByRole('checkbox', { checked: false })).toHaveCount(0);

  // «только» тоже не закрывает
  const wagon = classes.locator('.flt-row', { hasText: 'Вагон' });
  await wagon.hover();
  await wagon.getByRole('button', { name: 'только' }).click();
  await page.waitForTimeout(300);
  await expect(pop).toBeVisible();
  await expect(count).toHaveText('27');
  await shot('3-only.png');

  // Щелчок мимо по-прежнему закрывает
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);

  // Иконка агента — только пока рамка на проверке; принятая рамка агента её теряет
  const mark = page.locator('.mag-cv-lb .mag-cv-mark');
  await expect(mark).toHaveCount(1);
  await page.locator('.mag-cv-lb', { hasText: 'Человек' }).click();
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect.poll(() => puts.at(-1)?.[0]?.pending, 'рамка снята с проверки').toBe(false);
  await expect(mark).toHaveCount(0);
  await shot('4-confirmed.png');
  expect(errors, errors.join('\n')).toEqual([]);
  console.log('frame-class-filter-menu: ok');
} catch (e) {
  if (errors.length) console.log('Ошибки страницы:\n' + errors.join('\n---\n'));
  await shot('fail.png').catch(() => {});
  throw e;
} finally {
  await browser.close();
}
