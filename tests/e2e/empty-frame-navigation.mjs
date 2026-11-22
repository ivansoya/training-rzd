// Реальные Lanes и AnnotationEditor, API изолированы от рабочих данных.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const base = process.env.BASE || 'http://127.0.0.1:5181';
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
const created = '2026-11-10T09:00:00Z';
const project = { id: 'project', code: 'NUMBERED', name: 'Проверка кадров', status: 'ready', created_at: created };
const tags = [{ id: 'near', name: 'Ближняя камера' }, { id: 'far', name: 'Дальняя камера' }];
const numbered = [[11, 'new'], [10, 'empty'], [12, 'annotated'], [2, 'annotated'], [13, 'skipped'], [14, 'deleted']].map(([n, task_status]) => ({
  id: `numbered-${n}`, file_name: `${n}.jpg`, task_status, width: 800, height: 500,
  tag_ids: n === 2 || n === 14 ? ['near'] : n === 12 ? ['far'] : [],
  boxes: n === 12 ? Array.from({ length: 25 }, (_, i) => ({
    id: `box-${i}`, x: i * 12, y: 20, w: 10, h: 10, class_index: 0, pending: i < 24,
  })) : [],
}));
let canEdit = false;
let lastVerdict = null;
let savedBoxes = null;
try {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (/\/(file|thumb|preview)$/.test(path)) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><path fill="#647080" d="M0 0H800V500H0Z"/></svg>' });
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 'me', display_name: 'Проверка' }, projects: [{ ...project, role: 'viewer', role_label: 'Наблюдатель' }] } });
    if (path === `/api/projects/${project.code}`) return route.fulfill({ json: { project, my_role: 'viewer', members: [], datasets: [], classes: [] } });
    if (path === '/api/tasks/numbered') return route.fulfill({ json: {
      id: 'numbered', status: 'in_progress', status_at: created, created_at: created, name: 'Кадры по номерам', project,
      rights: { edit: canEdit, fill: false, moves: [] }, videos: [], tags, assignees: [], sources: { files: { total: 6, frames: 5 } },
    } });
    if (path === '/api/tasks/numbered/images') return route.fulfill({ json: { images: numbered, matched: numbered.length } });
    if (path === `/api/projects/${project.code}/classes` && canEdit) return route.fulfill({ json: { classes: [
      { id: 'wagon', class_index: 0, name: 'Вагон', color: '#f0bd58' },
      { id: 'rail', class_index: 1, name: 'Рельс', color: '#66aaff' },
    ] } });
    if (path === '/api/images/numbered-12/annotations' && route.request().method() === 'PUT') {
      savedBoxes = route.request().postDataJSON().boxes;
      return route.fulfill({ json: { saved: savedBoxes.length, clamped: 0, task_status: 'annotated', rev: 2 } });
    }
    if (path === '/api/images/numbered-11/task-status') {
      lastVerdict = route.request().postDataJSON();
      const image = numbered.find((item) => item.id === 'numbered-11');
      Object.assign(image, { task_status: lastVerdict.status, agent_empty: false, human_edited: true, my_edited_at: created, rev: 2 });
      return route.fulfill({ json: image });
    }
    if (path === '/api/tasks/numbered/questions') return route.fulfill({ json: { questions: canEdit ? [
      { id: 'agent-question', status: 'open', image_id: 'numbered-13', by_agent: true, messages: [] },
    ] : [] } });
    if (path === '/api/tasks/numbered/events') return route.fulfill({ json: { events: [] } });
    if (path === '/api/tasks/numbered/counts') return route.fulfill({ json: { counts: { total: 5, new: 1, skipped: 1, empty: 1, annotated: 2, deleted: 0, accepted: 0 }, by_source: {}, classes: [] } });
    if (path === '/api/agents/tasks/numbered/scouts') return route.fulfill({ json: { scouts: {} } });
    if (path === '/api/agents/tasks/numbered') return route.fulfill({ json: { agents: [], classes: [], mappings: {}, runs: [] } });
    if (path === '/api/invitations') return route.fulfill({ json: { invitations: [] } });
    if (path === '/api/friends') return route.fulfill({ json: { friends: [], incoming: [], outgoing: [] } });
    if (path === '/api/tasks/questions-inbox') return route.fulfill({ json: { items: [], total: 0 } });
    if (path === '/api/gpu') return route.fulfill({ json: { queue: { mine: [] } } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' });
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
    const { SamContourDetail } = await import('/src/components/editor/AutoSettings.tsx');
    function SamDetailFixture() {
      const [points, setPoints] = React.useState(64);
      window.testContourPoints = points;
      return React.createElement(SamContourDetail, { points, onPoints: setPoints });
    }
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
    ReactDOM.createRoot(document.getElementById('root')).render(h(BrowserRouter, null, h(AuthGate, null,
      h(location.search.includes('sam') ? SamDetailFixture : Fixture))));
    </script></html>` }));
  await page.goto(base + '/empty-navigation-test?sam');
  const detail = page.getByRole('slider', { name: 'Коэффициент детализации контура' });
  await expect(detail).toHaveAttribute('aria-valuetext', '1×');
  await detail.fill('0.5');
  await expect(detail).toHaveAttribute('aria-valuetext', '0,5×');
  expect(await page.evaluate(() => window.testContourPoints)).toBe(32);
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
  await page.goto(`${base}/projects/${project.code}/tasks/numbered`);
  await page.getByRole('button', { name: /Смотреть кадры/ }).click({ timeout: 5000 });
  await expect(page).toHaveURL(/frame=numbered-10$/);
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/frame=numbered-11$/);
  await page.reload();
  await page.getByRole('button', { name: 'Фильтр', exact: true }).click();
  const cells = page.locator('.fe-film .mag-fs-cell:not(.out)');
  const visibleNames = () => cells.evaluateAll((items) => items.map((item) => item.title.split(' — ')[0]));
  await expect.poll(visibleNames).toEqual(['2.jpg', '10.jpg', '11.jpg', '12.jpg', '13.jpg', '14.jpg']);

  const statuses = page.getByRole('group', { name: 'Статус кадра' });
  await statuses.getByRole('checkbox', { name: 'Размеченные' }).check();
  await expect.poll(visibleNames).toEqual(['2.jpg']);
  await statuses.getByRole('checkbox', { name: 'На проверку' }).check();
  await statuses.getByRole('checkbox', { name: 'Выброшенные' }).check();
  await expect.poll(visibleNames).toEqual(['2.jpg', '12.jpg', '14.jpg']);
  await page.getByRole('checkbox', { name: 'Ближняя камера' }).check();
  await expect.poll(visibleNames).toEqual(['2.jpg', '14.jpg']);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/frame=numbered-14$/);
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/frame=numbered-2$/);
  await page.getByRole('button', { name: 'Фильтр', exact: true }).click();
  await page.locator('.flt-pop').getByRole('button', { name: 'Сбросить' }).click();
  await expect.poll(visibleNames).toEqual(['2.jpg', '10.jpg', '11.jpg', '12.jpg', '13.jpg', '14.jpg']);
  await page.goto(`${base}/projects/${project.code}/tasks/numbered?frame=numbered-12`);
  const agentPanel = page.locator('.fe-side .fe-agent');
  await expect(agentPanel.locator('.fe-obj')).toHaveCount(24);
  await expect(page.locator('.fe-side .fe-objs:not(.fe-agent) .fe-obj')).toHaveCount(1);
  expect(await agentPanel.evaluate((section) => {
    section.scrollTop = section.scrollHeight;
    return getComputedStyle(section).overflowY === 'auto' && section.scrollTop > 0;
  })).toBe(true);
  const frameNotice = page.locator('.mag-cv-frame-notice');
  await expect(frameNotice).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(frameNotice).toHaveText('Отложен');
  await page.keyboard.press('ArrowRight');
  await expect(frameNotice).toHaveText('Брак');
  await page.keyboard.press('ArrowLeft');
  await expect(frameNotice).toHaveText('Отложен');
  await page.keyboard.press('ArrowLeft');
  await expect(frameNotice).toHaveCount(0);

  const header = page.locator('.ed-h');
  const progressOffset = () => header.evaluate((el) => {
    const head = el.getBoundingClientRect();
    const bar = el.querySelector('.ed-prog').getBoundingClientRect();
    return Math.abs((head.left + head.right - bar.left - bar.right) / 2);
  });
  await expect.poll(progressOffset).toBeLessThan(1);
  await header.locator('.ed-title > span').evaluate((el) => { el.textContent = 'Очень длинное название кадра '.repeat(20); });
  await expect.poll(progressOffset).toBeLessThan(1);
  await page.setViewportSize({ width: 600, height: 900 });
  await expect.poll(progressOffset).toBeLessThan(1);
  canEdit = true;
  numbered.find((item) => item.id === 'numbered-11').agent_empty = true;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/projects/${project.code}/tasks/numbered?frame=numbered-11`);
  const proposed = page.locator('.mag-fs-cell[title^="11.jpg"]');
  await expect(proposed).toHaveClass(/agent/);
  const agentQuestion = page.locator('.mag-fs-cell[title^="13.jpg"]');
  await expect(agentQuestion).toHaveClass(/agent/);
  await expect(agentQuestion).not.toHaveClass(/skipped/);
  await expect(agentQuestion.locator('.mag-fs-q')).toHaveCount(1);
  await expect(proposed.locator('.mag-fs-edited')).toHaveCount(0);
  await page.getByRole('button', { name: /Подтвердить пустой кадр/ }).click();
  await expect(proposed).not.toHaveClass(/agent/);
  await expect(proposed.locator('.mag-fs-edited')).toHaveCount(1);
  expect(lastVerdict).toEqual({ status: 'empty', review_empty: true });
  expect(errors).toEqual([]);
  console.log('PASS: frame order, filters, scrollable agent annotations and frame status overlays');

  await page.goto(`${base}/projects/${project.code}/tasks/numbered?frame=numbered-12`);
  await expect(page.locator('.mag-cv')).toHaveAttribute('aria-busy', 'false');
  await page.locator('.fe-side .fe-objs:not(.fe-agent) .fe-obj').click();
  const picked = page.locator('.mag-cv-labels .mag-cv-lb.on');
  await expect(picked).toContainText('Вагон');
  await page.keyboard.press('p');
  await expect(page.locator('.mag-cv')).toHaveClass(/cur-draw/);
  await page.keyboard.press('2');
  await expect(picked).toContainText('Рельс');
  await expect.poll(() => savedBoxes?.find((box) => box.id === 'box-24')?.class_index).toBe(1);
  expect(savedBoxes.map((box) => box.class_index)).toEqual([...Array(24).fill(0), 1]);
  expect(errors).toEqual([]);
  console.log('PASS: class shortcut updates the selected image annotation in polygon mode and autosaves it');
} catch (e) { console.error({ errors }); throw e; }
finally { await browser.close(); }
