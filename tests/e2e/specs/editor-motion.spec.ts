import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { signIn, tag } from "../helpers";

test("frame navigation keeps editor panels mounted and opaque", async ({ page }) => {
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  await page.request.post(`/api/projects/${project.code}/classes`, { data: { name: "Объект" } });
  const task = await (await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });
  const buffer = Buffer.from(await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 240;
    return c.toDataURL("image/jpeg").split(",")[1];
  }), "base64");
  for (const name of ["first.jpg", "second.jpg"]) {
    const res = await page.request.post(`/api/tasks/${task.id}/images`, {
      multipart: { files: { name, mimeType: "image/jpeg", buffer } },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const { images } = await (await page.request.get(`/api/tasks/${task.id}/images?limit=10`)).json();
  await page.request.put(`/api/images/${images[0].id}/annotations`, {
    data: { boxes: [{ class_index: 0, x: 20, y: 20, w: 40, h: 50 }] },
  });
  await page.request.put(`/api/images/${images[1].id}/annotations`, {
    data: { boxes: [{ class_index: 0, x: 120, y: 20, w: 40, h: 50 }] },
  });
  let releasePreview!: () => void;
  const heldPreview = new Promise<void>((resolve) => { releasePreview = resolve; });
  await page.route(`**/api/images/${images[1].id}/preview`, async (route) => {
    await heldPreview;
    await route.continue();
  });
  // Keep the fixture local to this browser; no agent inference is needed.
  await page.route(`**/api/tasks/${task.id}/images?*`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const image of body.images) if (image.id === images[0].id) {
      image.boxes = image.boxes.map((b: object) => ({ ...b, source: "model", pending: true }));
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/projects/${project.code}/tasks/${task.id}?frame=${images[0].id}`);
  const editor = page.getByRole("dialog", { name: "Разметка кадров" });
  await expect(editor.locator(".ed-top")).toBeVisible();
  const review = editor.locator(".ed-review");
  await expect(review.getByRole("button", { name: /^Принять все/ })).toBeEnabled();
  await page.waitForTimeout(300);
  await editor.evaluate((root) => {
    const panels = [...root.querySelectorAll(".ed-float")];
    (window as any).motionProbe = { panels, removed: [] as string[], width: root.querySelector(".ed-review")!.getBoundingClientRect().width };
    new MutationObserver((records) => {
      for (const record of records) for (const n of record.removedNodes) {
        if (n instanceof Element && panels.some((p) => p === n || n.contains(p))) {
          (window as any).motionProbe.removed.push(n.className);
        }
      }
    }).observe(root, { childList: true, subtree: true });
  });
  await editor.locator(`.mag-fs-cell[title^="${images[1].file_name}"]`).click();
  await expect(editor.locator(".ed-h")).toContainText(images[1].file_name);
  await expect(editor.locator(".mag-cv-sh:not(.mag-cv-ov), .mag-cv-lb")).toHaveCount(0);
  releasePreview();
  await expect(editor.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).motionProbe.removed)).toEqual([]);
  await expect(review.getByRole("button", { name: /^Принять все/ })).toBeDisabled();
  // The caption may change length; the action row must stay in place instead of collapsing.
  expect(await review.evaluate((el) => el.getBoundingClientRect().width / (window as any).motionProbe.width)).toBeGreaterThan(.9);
  await editor.screenshot({ path: test.info().outputPath("frame-motion.png") });
});

test("video frame changes keep the cursor and toolbar steady", async ({ page }) => {
  if (!process.env.TEST_SAMPLE_VIDEO) execFileSync("python3", ["-c", "from sample import ensure; ensure()"]);
  await signIn(page);
  const project = await (await page.request.post("/api/projects", { data: { name: tag() } })).json();
  const task = await (await page.request.post(`/api/projects/${project.code}/tasks`, { data: { name: tag() } })).json();
  await page.request.post(`/api/tasks/${task.id}/status`, { data: { status: "in_progress" } });
  const uploaded = await page.request.post(`/api/tasks/${task.id}/videos`, { multipart: {
    file: { name: "motion.mp4", mimeType: "video/mp4", buffer: readFileSync(process.env.TEST_SAMPLE_VIDEO || "/tmp/magistral-sample-30f.mp4") }, mode: "annotate",
  } });
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  await page.goto(`/projects/${project.code}/tasks/${task.id}`);
  await page.getByRole("button", { name: "Размечать ролик" }).click();
  const editor = page.getByRole("dialog", { name: "Разметка видео" });
  await expect(editor.locator(".mag-cv-frame canvas")).toBeVisible({ timeout: 60000 });
  // Record every browser frame, including the render before the decoder resolves.
  await editor.evaluate((root) => {
    (window as any).motionProbe = { samples: [] as { cursor: string; opacity: string }[] };
    const sample = () => {
      (window as any).motionProbe.samples.push({ cursor: getComputedStyle(root.querySelector(".mag-cv")!).cursor,
        opacity: getComputedStyle(root.querySelector(".ed-top .ed-tool")!).opacity });
      (window as any).motionProbe.raf = requestAnimationFrame(sample);
    };
    sample();
  });
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
  await expect(editor.getByRole("slider", { name: "Кадр", exact: true })).toHaveAttribute("aria-valuenow", "8");
  const samples = await page.evaluate(() => {
    cancelAnimationFrame((window as any).motionProbe.raf);
    return (window as any).motionProbe.samples as { cursor: string; opacity: string }[];
  });
  expect(samples.length).toBeGreaterThan(1);
  expect(samples.some((s) => s.cursor === "wait" || s.cursor === "progress")).toBe(false);
  expect(samples.every((s) => s.opacity === "1")).toBe(true);
  await editor.screenshot({ path: test.info().outputPath("video-motion.png") });
});
