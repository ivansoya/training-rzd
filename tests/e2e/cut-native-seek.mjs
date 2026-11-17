// Настоящий HTMLVideoElement и созданный в браузере VP8-ролик; серверные данные не трогаем.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const base = process.env.BASE || 'http://127.0.0.1:5181';
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.route('**/record-test', (r) => r.fulfill({ contentType: 'text/html', body: '<canvas width="320" height="180"></canvas>' }));
  await page.goto(base + '/record-test');
  const clip = Buffer.from(await page.evaluate(async () => {
    const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d'), stream = canvas.captureStream(25);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((resolve) => { recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))); });
    let frame = 0;
    recorder.start();
    const timer = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#536b83' : '#839553'; ctx.fillRect(0, 0, 320, 180); }, 40);
    await new Promise((r) => setTimeout(r, 2000)); clearInterval(timer); recorder.stop();
    stream.getTracks().forEach((t) => t.stop()); return done;
  }));
  expect(clip.length).toBeGreaterThan(500);
  await page.route('**/api/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    if (!p.startsWith('/api/')) return r.continue();
    if (p.endsWith('/file')) {
      const range = r.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
      const start = Number(range?.[1] || 0), end = Math.min(clip.length - 1, Number(range?.[2] || clip.length - 1));
      return r.fulfill({ status: range ? 206 : 200, contentType: 'video/webm',
        headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${clip.length}` } : {}) }, body: clip.subarray(start, end + 1) });
    }
    if (p.endsWith('/strip')) return r.fulfill({ status: 204 });
    return r.fulfill({ json: { scouts: {}, frames: 0, add: 0, remove: 0 } });
  });
  await page.route('**/native-seek-test', (r) => r.fulfill({ contentType: 'text/html', body: `
    <meta charset="utf-8"><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: Cut } = await import('/src/components/mag/VideoCutModal.tsx');
    for (const f of ['common','editor','tokens','ui','layout','cut']) await import('/src/styles/' + f + '.css');
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Cut, { taskId: 'test', editable: true, startAtMs: 200,
      video: { id: 'video', file_name: 'Реальный декодер.webm', duration_ms: 1000, fps: 25, width: 320, height: 180, segments: [] }, onClose() {}, onDone() {} }));
    </script>` }));
  await page.goto(base + '/native-seek-test');
  const stage = page.locator('.vc-stage'), video = page.locator('.vc-stage > video:not(.vc-hidden)');
  await expect(stage).toHaveAttribute('aria-busy', 'false');
  expect(await video.evaluate((v) => v.currentTime)).toBeCloseTo(0.2, 3);
  for (const [key, expected] of [['ArrowRight', 0.84], ['ArrowLeft', 0.2], ['Shift+ArrowRight', 0.999], ['Shift+ArrowLeft', 0]]) {
    for (let i = 0; i < 16; i++) await page.keyboard.press(key);
    await expect(stage).toHaveAttribute('aria-busy', 'false');
    expect(await video.evaluate((v) => v.currentTime)).toBeCloseTo(expected, 3);
  }
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate((v) => v.paused)).toBe(false);
  await page.keyboard.press('Space');
  expect(errors).toEqual([]);
  console.log('PASS: native VP8 decoder, initial position, repeated seeks both ways, Shift and boundaries, playback');
} catch (e) { console.error({ errors, media: await page.locator('video').evaluateAll((vs) => vs.map((v) => ({ t: v.currentTime, duration: v.duration, seeking: v.seeking, ready: v.readyState, error: v.error?.message, buffered: v.buffered.length && v.buffered.end(0) }))) }); throw e; }
finally { await browser.close(); }
