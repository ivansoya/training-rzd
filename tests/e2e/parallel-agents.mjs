// Actual React dialog/run bar against controlled API responses. Run with Vite on BASE.
import { chromium, expect } from "@playwright/test";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = process.env.BASE || "http://127.0.0.1:5173";
const harness = new URL(`../../frontend/.parallel-check-${process.pid}.tsx`, import.meta.url);
const harnessUrl = `/${harness.pathname.split("/").at(-1)}`;
const out = new URL("../../design-mockups/2026-11-10-parallel-agents/previews/", import.meta.url);
const created = new Date().toISOString();
const videos = [1, 2, 3].map((i) => ({ id: `video-${i}`, file_name: `camera_close_2026-10-25_10-33-${i}.mp4`, mode: "annotate", frames: 200 }));
const verdict = { state: "fits", want_mb: 6000, card: "Test GPU", reason: "Есть свободная память" };
const context = {
  agents: [{ id: "agent", name: "Борщевик", head: "version", group: "project", mine: true, owner: "Тест", verdict,
    versions: [{ id: "version", version: 3, classes: [], created_at: created }] }],
  resources: { cards: [{ id: "card", index: 0, name: "Test GPU", cap_mb: 24000, free_mb: 18000 }], queued: 0 },
  videos, classes: [], mappings: {}, sources: {}, runs: [], can_run: true,
};
const errors = [], requests = [];
let run = null;
const browser = await chromium.launch({ channel: "chrome", args: ["--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets"] });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const settle = () => page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all(document.getAnimations().filter((a) => a.effect.getComputedTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {})));
});
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("requestfailed", (r) => errors.push(`${r.url()}: ${r.failure()?.errorText}`));
const copy = (slot, status = "running") => ({
  id: `copy-${slot}`, slot, status, current: videos[slot - 1].file_name, item_processed: 2, item_total: 8,
  processed: 2, total: 8, stats: {}, rate: null, agent: "Борщевик", version: 3,
  mode: "scout", sources: [], videos: [videos[slot - 1].id], created_at: created, error: null, queue_reason: null,
});
try {
  await mkdir(out, { recursive: true });
  await writeFile(harness, `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {BrowserRouter} from 'react-router-dom';
    import AgentRunDialog, {AgentRunBar} from './src/components/agents/AgentRunDialog';
    import './src/styles/common.css'; import './src/styles/tokens.css'; import './src/styles/ui.css';
    import './src/styles/layout.css'; import './src/styles/graphed.css';
    import '@fontsource/onest/400.css'; import '@fontsource/onest/500.css'; import '@fontsource/onest/600.css';
    function Harness() {
      const [open,setOpen]=useState(true), [run,setRun]=useState(null);
      window.setRunCheck=setRun;
      return <BrowserRouter><main style={{padding:24}}><h1>Тест-камеры-движение-26.10.2026</h1>
        <AgentRunBar taskId="task" run={run} onRun={setRun} onFinished={()=>{}} />
        {open && <AgentRunDialog taskId="task" initial={{mode:'scout',modes:['scout'],videos:['video-1','video-2','video-3']}}
          onClose={()=>setOpen(false)} onStarted={(r)=>{setRun(r);setOpen(false)}} />}
      </main></BrowserRouter>
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `);
  await page.route("**/parallel-check", (route) => route.fulfill({ contentType: "text/html", body: `<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="${harnessUrl}"></script>` }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/parallel-capacity")) return route.fulfill({ json: {
      max_count: 3, work_count: 3, per_copy_mb: 6000, batch_size: 60, limit: 8, cards: context.resources.cards,
    } });
    if (path === "/api/agents/tasks/task/runs") {
      const body = route.request().postDataJSON(); requests.push(body);
      const n = body.copies === "auto" ? 3 : body.copies;
      run = { id: "group", status: "running", processed: 4, total: 24, stats: {}, rate: null, error: null,
        queue_reason: null, agent: "Борщевик", version: 3, mode: "scout", sources: [], videos: videos.map((v) => v.id),
        created_at: created, parallel: { count: n, pending: 1, copies: Array.from({ length: n }, (_, i) => copy(i + 1)) } };
      return route.fulfill({ status: 202, json: run });
    }
    if (/\/runs\/[^/]+\/(stop|resume)$/.test(path)) {
      requests.push(path);
      const id = path.split("/").at(-2);
      const item = run.parallel.copies.find((c) => c.id === id);
      if (item) item.status = path.endsWith("/stop") ? "stopped" : "running";
      return route.fulfill({ json: item ?? run });
    }
    if (path === "/api/agents/tasks/task") return route.fulfill({ json: { ...context, runs: run ? [run] : [] } });
    return route.fulfill({ status: 404, json: { error: "Unexpected API " + path } });
  });
  await page.goto(base + "/parallel-check");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Агент", { exact: true })).toBeVisible();
  await settle();
  const before = await dialog.boundingBox();
  await page.getByRole("button", { name: "Несколько агентов", exact: true }).click();
  await expect(page.getByText("Сейчас до 3 агентов", { exact: false })).toBeVisible();
  const select = page.getByRole("combobox", { name: "Количество агентов" });
  await expect(select).toHaveText(/Максимум по видеопамяти/);
  await select.focus(); await page.keyboard.press("ArrowDown");
  await expect(page.locator(".ui-select-pop")).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("option", { name: "Своё количество…" })).toBeFocused();
  await page.keyboard.press("Enter");
  const input = page.getByRole("textbox", { name: "Своё количество" });
  await expect(input).toBeVisible();
  for (const value of ["", "0", "1.5", "4", "abc"]) {
    await input.fill(value);
    await expect(dialog.getByRole("button", { name: "Запустить агентов", exact: true })).toBeDisabled();
    await expect(input).toHaveAttribute("aria-invalid", "true");
  }
  await input.fill("2");
  await expect(input).toHaveAttribute("aria-invalid", "false");
  const after = await dialog.boundingBox();
  expect(after).toEqual(before);
  await page.screenshot({ path: fileURLToPath(new URL("implementation-custom.png", out)) });
  await dialog.getByRole("button", { name: "Запустить 2 агентов", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests[0]).toMatchObject({ parallel: true, copies: 2, mode: "scout", videos: videos.map((v) => v.id) });
  await expect(page.locator(".ar-copy")).toHaveCount(2);
  await page.getByRole("button", { name: "Остановить агента 1", exact: true }).click();
  await expect(page.locator(".ar-copy").first().getByRole("button", { name: "Продолжить" })).toBeVisible();
  await page.locator(".ar-copy").first().getByRole("button", { name: "Продолжить" }).click();
  await expect(page.getByRole("button", { name: "Остановить агента 1", exact: true })).toBeVisible();
  run.parallel.copies[0].status = "error"; run.parallel.copies[0].error = "Не хватило видеопамяти";
  await page.evaluate((r) => window.setRunCheck(r), run);
  await expect(page.locator(".ar-copy").first().getByRole("button", { name: "Повторить" })).toBeVisible();
  await expect(page.locator(".ar-copy").last()).toHaveClass(/running/);
  await settle();
  await page.screenshot({ path: fileURLToPath(new URL("implementation-error.png", out)) });
  run.status = "done"; run.processed = 24; run.parallel.pending = 0;
  run.stats = { videos: 3, frames: 4, completed_videos: videos.map((v) => v.id) };
  run.parallel.copies.forEach((c) => { c.status = "done"; c.error = null; c.current = null; c.processed = 12; c.item_processed = 0; c.item_total = 0; });
  await page.evaluate((r) => window.setRunCheck(r), run);
  await expect(page.locator(".ar-bar")).toHaveClass(/done/);
  await settle();
  await expect(page.getByRole("progressbar", { name: "Ход прогона", exact: true })).toHaveAttribute("aria-valuenow", "100");
  await page.screenshot({ path: fileURLToPath(new URL("implementation-done.png", out)) });
  await page.getByRole("button", { name: "Скрыть", exact: true }).click();
  await expect(page.locator(".ar-bar")).toHaveCount(0);
  for (const width of [1024, 390]) {
    run = null;
    await page.setViewportSize({ width, height: 844 });
    await page.goto(base + "/parallel-check");
    await expect(page.getByLabel("Агент", { exact: true })).toBeVisible();
    await settle();
    const box = await page.getByRole("dialog").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Несколько агентов", exact: true }).click();
  expect(await page.locator(".ar-expand").first().evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThan(0.001);
  expect(errors).toEqual([]);
  console.log("PASS: actual dialog, stable layout, styled keyboard select, custom count, copy stop/retry, green dismissible completion, mobile, reduced motion");
} catch (error) {
  console.error("Browser errors:", errors);
  await page.screenshot({ path: fileURLToPath(new URL("implementation-failure.png", out)), fullPage: true });
  throw error;
} finally {
  await browser.close();
  await unlink(harness).catch(() => {});
}
