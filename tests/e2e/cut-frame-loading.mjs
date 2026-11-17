// Реальный VideoCutModal, изолированные API и управляемая задержка браузерного seek.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const base = process.env.BASE || 'http://127.0.0.1:5181';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('requestfailed', (r) => console.log('request failed', r.url(), r.failure()));
page.on('response', (r) => { if (r.status() >= 400) console.log('response', r.status(), r.url()); });
const out = 'tests/e2e/test-results/cut-frame-loading';
try {
  await mkdir(out, { recursive: true });
  await page.addInitScript(() => {
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this instanceof HTMLMediaElement && name === 'src') {
        setTimeout(() => this.dispatchEvent(new Event('loadeddata')), 20);
        return;
      }
      return setAttribute.call(this, name, value);
    };
    const states = new WeakMap();
    window.mediaTest = { delay: 160, requests: [], completed: [] };
    const state = (v) => {
      if (!states.has(v)) states.set(v, { at: 0, seeking: false, paused: true, timer: 0 });
      return states.get(v);
    };
    Object.defineProperties(HTMLMediaElement.prototype, {
      readyState: { get() { return state(this).seeking ? 1 : 4; } },
      seeking: { get() { return state(this).seeking; } },
      paused: { get() { return state(this).paused; } },
      currentTime: {
        get() { return state(this).at; },
        set(at) {
          const s = state(this); s.at = at; s.seeking = true;
          clearTimeout(s.timer);
          if (this.matches('.vc-stage > video:not(.vc-hidden)')) window.mediaTest.requests.push(at);
          this.dispatchEvent(new Event('seeking'));
          s.timer = setTimeout(() => {
            s.seeking = false;
            if (this.matches('.vc-stage > video:not(.vc-hidden)')) window.mediaTest.completed.push(at);
            this.dispatchEvent(new Event('seeked')); this.dispatchEvent(new Event('timeupdate'));
          }, window.mediaTest.delay);
        },
      },
    });
    HTMLMediaElement.prototype.play = function () { state(this).paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { state(this).paused = true; this.dispatchEvent(new Event('pause')); };
  });
  const scout = { fps: 25, step: 25, created_at: '2026-11-17', last_frame: 1499, segments: { 'Вагон': [[0, 1499, 60]] } };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path.endsWith('/file')) return route.fulfill({ status: 204 });
    if (path.endsWith('/strip')) return route.fulfill({ status: 204 });
    if (path.endsWith('/scouts')) return route.fulfill({ json: { scouts: { video: scout } } });
    if (path.endsWith('/scouts/video')) return route.fulfill({ json: { ...scout, checked: Array.from({ length: 60 }, (_, i) => i * 25),
      frames: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i * 25, [['Вагон', 0.9, 100, 100, 200, 150]]])), mapped: {} } });
    return route.fulfill({ json: { frames: 0, add: 0, remove: 0 } });
  });
  await page.route('**/cut-loading-test', (route) => route.fulfill({ contentType: 'text/html', body: `
    <html lang="ru"><meta charset="utf-8"><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: Cut } = await import('/src/components/mag/VideoCutModal.tsx');
    for (const file of ['common','editor','video','tokens','ui','layout','cut','editor-ui']) await import('/src/styles/' + file + '.css');
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Cut, { taskId: 'test', editable: true,
      video: { id: 'video', file_name: 'Камера.mp4', duration_ms: 60000, fps: 25, width: 1280, height: 720, segments: [] },
      onClose() {}, onDone() {} }));
    </script></html>` }));
  const open = async () => {
    await page.goto(base + '/cut-loading-test');
    await expect(page.locator('.vc-ghosts')).toBeVisible();
  };
  await open();
  const mode = process.env.CHECK || 'all';
  if (mode === 'all' || mode === 'loading') {
    await page.evaluate(() => { window.mediaTest.delay = 2200; });
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.vc-ghosts')).toHaveCount(0, { timeout: 300 });
    await expect(page.locator('.vc-objects')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Кадр F', exact: true })).toBeDisabled();
    await page.keyboard.press('f');
    await expect(page.locator('.vc-one-t')).toHaveCount(0);
    await page.waitForTimeout(600);
    await expect(page.locator('.vc-frame-wait')).toHaveCount(0);
    await expect(page.locator('.vc-frame-wait')).toBeVisible({ timeout: 1400 });
    await page.screenshot({ path: out + '/loading.png' });
    await expect(page.locator('.vc-frame-wait')).toHaveCount(0, { timeout: 1000 });
    await expect(page.locator('.vc-ghosts')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.locator('.vc-ghosts')).toBeVisible();
    await page.keyboard.press('Space');
    console.log('PASS: ghosts hidden only during loading, veil after 1s, restored on pause/play');
  }
  if (mode === 'all' || mode === 'repeat') {
    for (const key of ['ArrowRight', 'ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowLeft']) {
      await open();
      await page.evaluate(() => { document.querySelector('.vc-stage > video').currentTime = 10; });
      await page.waitForTimeout(220);
      await page.evaluate(() => { window.mediaTest.requests = []; window.mediaTest.completed = []; });
      const code = key.split('+').at(-1), shiftKey = key.startsWith('Shift');
      for (let i = 0; i < 16; i++) {
        await page.evaluate(({ code, shiftKey, i }) => window.dispatchEvent(new KeyboardEvent('keydown', { code, shiftKey, repeat: i > 0, bubbles: true })), { code, shiftKey, i });
        await page.waitForTimeout(30);
      }
      const during = await page.evaluate(() => ({ requests: window.mediaTest.requests.length, completed: window.mediaTest.completed.length }));
      console.log(key, during);
      expect(during.completed, 'Удержание не должно бесконечно прерывать декодирование').toBeGreaterThan(0);
      expect(during.requests).toBeLessThan(8);
      await page.waitForTimeout(400);
      const times = await page.evaluate(() => window.mediaTest);
      const delta = (shiftKey ? 1 : 0.04) * (code === 'ArrowLeft' ? -1 : 1);
      expect(times.completed.at(-1)).toBeCloseTo(Math.max(0, 10 + 16 * delta), 5);
    }
    console.log('PASS: repeated forward/backward and second steps complete seeks and preserve final target');
  }
  expect(errors).toEqual([]);
} catch (e) { console.error({ errors, media: await page.locator('video').evaluateAll((vs) => vs.map((v) => ({ src: v.src, error: v.error?.message }))), body: (await page.locator('body').innerText()).slice(0, 1000) }); throw e; }
finally { await browser.close(); }
