// Реальные Lanes и AnnotationEditor, API изолированы от рабочих данных.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const base = process.env.BASE || 'http://127.0.0.1:5181';
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (/\/(file|thumb)$/.test(path)) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><path fill="#647080" d="M0 0H800V500H0Z"/></svg>' });
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 'me', display_name: 'Проверка' }, projects: [] } });
    return route.fulfill({ json: { classes: [], boxes: [], agents: [], mappings: {}, sessions: [], rev: null } });
  });
  await page.route('**/empty-navigation-test*', (route) => route.fulfill({ contentType: 'text/html', body: `
    <html lang="ru"><meta charset="utf-8"><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { BrowserRouter } = await import('/node_modules/.vite/deps/react-router-dom.js');
    const { default: AuthGate } = await import('/src/components/auth/AuthGate.tsx');
    const { default: Editor } = await import('/src/components/mag/AnnotationEditor.tsx');
    const { Lanes } = await import('/src/components/editor/Lanes.tsx');
    for (const file of ['common','editor','video','tokens','ui','layout','editor-ui']) await import('/src/styles/' + file + '.css');
    const h = React.createElement, noop = () => {};
    function Fixture() {
      const [index, setIndex] = React.useState(0), [frame, setFrame] = React.useState(0);
      window.testPosition = { index, frame };
      if (location.search.includes('lanes')) return h(Lanes, { tracks: [], numbers: new Map(), frame, lastFrame: 1000, fps: 25,
        labelOf: () => ({ name: 'Вагон', color: '#acb' }), selected: null, editable: false, hidden: new Set(),
        filter: { classes: [], agent: [], off: new Set(), onChange: noop, cut: 0 }, covered: [], marks: [{ frame: 127, on: true }, { frame: 420, on: false }],
        plan: 2, singles: [], agent: [], scout: [], scouted: false, scoutOpen: false, view: { from: 0, len: 1000 },
        onView: noop, chunks: [], loaded: new Set(), inFlight: null, loading: false, onScout: noop, onSelect: noop, onHide: noop, onAction: noop, onSeek: setFrame });
      return h(Editor, { code: 'test', scope: { kind: 'task', taskId: 'test', taskName: 'Пустые кадры' },
        images: ['new','new','empty','deleted'].map((task_status, i) => ({ id: 'image-' + i, task_status, file_name: 'Кадр ' + i, width: 800, height: 500, boxes: [], annotations: 0, tag_ids: [] })),
        index, readOnly: true, tags: [], people: [], canTag: false, onIndex: setIndex, onClose: noop, onChanged: noop, onTags: noop, onTagCreated: noop });
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(BrowserRouter, null, h(AuthGate, null, h(Fixture))));
    </script></html>` }));
  await page.goto(base + '/empty-navigation-test?lanes');
  await page.getByRole('button', { name: 'Перейти к кадру 127, помеченному пустым' }).click();
  await expect.poll(() => page.evaluate(() => window.testPosition.frame)).toBe(127);
  await page.getByRole('button', { name: 'Перейти к кадру 420, помеченному пустым' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.testPosition.frame)).toBe(420);
  await page.goto(base + '/empty-navigation-test');
  await page.getByRole('button', { name: 'Следующий размеченный кадр (])', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testPosition.index)).toBe(2);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => page.evaluate(() => window.testPosition.index)).toBe(1);
  await page.keyboard.press('BracketRight');
  await expect.poll(() => page.evaluate(() => window.testPosition.index)).toBe(2);
  expect(errors).toEqual([]);
  console.log('PASS: exact empty video tick, inactive mark keyboard access, empty image button and bracket navigation');
} catch (e) { console.error({ errors }); throw e; }
finally { await browser.close(); }
