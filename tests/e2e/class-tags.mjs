// Настоящий экран «Классы»: таги классов в панели, таблице и отборе. API подменён.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const base = process.env.BASE || 'http://127.0.0.1:5181';
const out = new URL('./test-results/class-tags/', import.meta.url);
const shot = (name) => page.screenshot({ path: fileURLToPath(new URL(name, out)) });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));

// Справочник и классы живут в сценарии: сервер отвечает так же, как project_routes
let seq = 0;
const tags = [{ id: 't-people', name: 'Люди' }];
const classes = [
  { id: 'c0', class_index: 0, name: 'Человек', color: '#46a758', superclass_id: null, superclass_name: null, tagIds: ['t-people'], annotations: 12, images: 5, split: { train: 8, val: 4, other: 0 } },
  { id: 'c1', class_index: 1, name: 'Вагон', color: '#f0bd58', superclass_id: null, superclass_name: null, tagIds: [], annotations: 30, images: 9, split: { train: 25, val: 5, other: 0 } },
  { id: 'c2', class_index: 2, name: 'Опора', color: '#3e63dd', superclass_id: null, superclass_name: null, tagIds: [], annotations: 0, images: 0, split: { train: 0, val: 0, other: 0 } },
];
const calls = [];
const byName = (a, b) => a.name.toLocaleLowerCase('ru').localeCompare(b.name.toLocaleLowerCase('ru'));
const view = (c) => ({ ...c, tagIds: undefined, tags: c.tagIds.map((id) => tags.find((t) => t.id === id)).sort(byName) });
const setTags = (c, names) => {
  c.tagIds = names.map((n) => {
    let t = tags.find((x) => x.name.toLocaleLowerCase('ru') === n.toLocaleLowerCase('ru'));
    if (!t) { t = { id: `t-${++seq}`, name: n }; tags.push(t); }
    return t.id;
  });
};
try {
  await mkdir(out, { recursive: true });
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const body = req.method() === 'GET' || req.method() === 'DELETE' ? null : req.postDataJSON();
    if (req.method() !== 'GET') calls.push({ method: req.method(), path, body });
    if (path === '/api/projects/test/classes' && req.method() === 'GET') return route.fulfill({ json: {
      classes: classes.map(view), superclasses: [], can_edit: true, can_manage: true,
      class_tags: [...tags].sort(byName).map((t) => ({ ...t, classes: classes.filter((c) => c.tagIds.includes(t.id)).length })),
    } });
    const one = /^\/api\/projects\/test\/classes\/(c\d+)$/.exec(path);
    if (one && req.method() === 'PATCH') {
      const c = classes.find((x) => x.id === one[1]);
      if (body.name) c.name = body.name;
      if (body.tags) setTags(c, body.tags);
      return route.fulfill({ json: view(c) });
    }
    const tag = /^\/api\/projects\/test\/class-tags\/(t-[\w-]+)$/.exec(path);
    if (tag && req.method() === 'PATCH') {
      tags.find((t) => t.id === tag[1]).name = body.name;
      return route.fulfill({ json: { id: tag[1], name: body.name } });
    }
    if (tag && req.method() === 'DELETE') {
      const freed = classes.filter((c) => c.tagIds.includes(tag[1])).length;
      classes.forEach((c) => { c.tagIds = c.tagIds.filter((id) => id !== tag[1]); });
      tags.splice(tags.findIndex((t) => t.id === tag[1]), 1);
      return route.fulfill({ json: { ok: true, classes_untagged: freed } });
    }
    return route.fulfill({ json: {} });
  });
  await page.route('**/class-tags-test*', (route) => route.fulfill({ contentType: 'text/html', body: `
    <html lang="ru"><meta charset="utf-8"><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    // Тот же адрес модуля, что у приложения (с ?v=): иначе у Outlet и useOutletContext разные контексты
    const shell = await (await fetch('/src/components/mag/ProjectShell.tsx')).text();
    const routerUrl = /from "(\\/node_modules\\/\\.vite\\/deps\\/react-router-dom\\.js[^"]*)"/.exec(shell)[1];
    const { MemoryRouter, Routes, Route, Outlet } = await import(routerUrl);
    const { default: ProjectClasses } = await import('/src/components/mag/classes/ProjectClasses.tsx');
    for (const file of ['tokens','ui','common','layout']) await import('/src/styles/' + file + '.css');
    const h = React.createElement;
    const detail = { project: { id: 'p', code: 'test', name: 'Таги классов', status: 'ready' } };
    const Shell = () => h(Outlet, { context: { detail, refresh: async () => {} } });
    ReactDOM.createRoot(document.getElementById('root')).render(h(MemoryRouter, { initialEntries: ['/projects/test/classes'] },
      h(Routes, null, h(Route, { element: h(Shell) }, h(Route, { path: '/projects/:code/classes', element: h(ProjectClasses) })))));
    </script></html>` }));

  await page.goto(base + '/class-tags-test');
  const rows = page.locator('tr.cls-row');
  await expect(rows).toHaveCount(3);
  const row = (name) => rows.filter({ hasText: name });
  await expect(row('Человек').locator('.cls-tags')).toHaveText('Люди');
  await expect(row('Вагон').locator('td').nth(2)).toHaveText('—');
  await shot('1-table.png');

  // Новый таг заводится в карточке класса и пишется при сохранении
  const side = page.locator('.cls-side');
  await row('Вагон').click();
  await side.getByRole('button', { name: '+ добавить таг' }).click();
  await side.getByPlaceholder('найти или завести').fill('Подвижной состав');
  await page.keyboard.press('Enter');
  await expect(side.locator('.tagp-chip.on')).toHaveText(['Подвижной состав×']);
  await shot('2-panel-new-tag.png');
  await side.getByRole('button', { name: 'Сохранить' }).click();
  await expect.poll(() => calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/api/projects/test/classes/c1', body: { tags: ['Подвижной состав'] } });
  await expect(row('Вагон').locator('.cls-tags')).toHaveText('Подвижной состав');

  // Набранное другим регистром — существующий таг, а не второй такой же
  await row('Человек').click();
  await side.getByRole('button', { name: '+ добавить таг' }).click();
  await side.getByPlaceholder('найти или завести').fill('подвижной состав');
  await expect(side.getByRole('button', { name: /Завести таг/ })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await side.getByRole('button', { name: 'Сохранить' }).click();
  await expect.poll(() => calls.at(-1)?.body).toEqual({ name: 'Человек', color: '#46a758', superclass_id: null, tags: ['Люди', 'Подвижной состав'] });
  expect(tags.length).toBe(2);

  // Отбор по тагу и «Без тагов»
  await page.locator('button.cls-gbtn').filter({ hasText: 'Все таги' }).click();
  await shot('3-tag-menu.png');
  await page.locator('.cls-gpop').getByRole('button', { name: /^Подвижной состав/ }).click();
  await expect(rows).toHaveCount(2);
  await page.locator('button.cls-gbtn').filter({ hasText: 'Подвижной состав' }).click();
  await page.locator('.cls-gpop').getByRole('button', { name: /^Без тагов/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Опора');
  await page.locator('button.cls-gbtn').filter({ hasText: 'Без тагов' }).click();
  await page.locator('.cls-gpop').getByRole('button', { name: /^Все таги/ }).click();
  await expect(rows).toHaveCount(3);

  // Переименование и удаление тага — во всех классах сразу
  await page.locator('button.cls-gbtn').filter({ hasText: 'Все таги' }).click();
  await page.getByRole('button', { name: 'Изменить таг «Подвижной состав»' }).click();
  await expect(side).toContainText('Стоит у 2 классов');
  await side.getByLabel('Название').fill('люди');
  await expect(side).toContainText('Таг «Люди» уже есть');
  await expect(side.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  await side.getByLabel('Название').fill('Транспорт');
  await side.getByRole('button', { name: 'Сохранить' }).click();
  await expect(row('Вагон').locator('.cls-tags')).toHaveText('Транспорт');
  await side.getByRole('button', { name: 'Удалить таг' }).click();
  await expect(side).toContainText('Таг снимется с 2 классов');
  await shot('4-tag-delete.png');
  await side.getByRole('button', { name: 'Удалить таг' }).click();
  await expect(row('Вагон').locator('td').nth(2)).toHaveText('—');
  await expect(row('Человек').locator('.cls-tags')).toHaveText('Люди');

  // Узкие экраны: таблица не выпирает из документа
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await page.waitForTimeout(200);
    await shot(`5-width-${width}.png`);
    console.log(`ширина ${width}: документ ${await page.evaluate(() => document.documentElement.scrollWidth)}`);
  }
  expect(errors, errors.join('\n')).toEqual([]);
  console.log(`class-tags: ok, запросов записи ${calls.length}`);
} catch (e) {
  if (errors.length) console.log('Ошибки страницы:\n' + errors.join('\n---\n'));
  await shot('fail.png').catch(() => {});
  throw e;
} finally {
  await browser.close();
}
