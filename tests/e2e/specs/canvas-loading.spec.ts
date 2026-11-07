import { expect, test } from "@playwright/test";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4xkAAAAASUVORK5CYII=", "base64");

test.beforeEach(async ({ page }) => {
  await page.route("**/canvas-images/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.goto("/tests/canvas-loading.html");
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(1);
});

test("images hide annotations, labels and scout findings until the new image decodes", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/canvas-images/slow.png", async (route) => {
    await held;
    await route.fulfill({ contentType: "image/png", body: png });
  });
  await page.evaluate(() => (window as any).canvasFixture.image("slow", "/canvas-images/slow.png"));
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(0);
  await expect(page.locator(".mag-cv-lb, .mag-cv-ghost-hit")).toHaveCount(0);
  const stage = (await page.locator(".mag-cv").boundingBox())!;
  await page.mouse.move(stage.x + 40, stage.y + 40); await page.mouse.down();
  await page.mouse.move(stage.x + 100, stage.y + 100); await page.mouse.up();
  expect(await page.evaluate(() => (window as any).edits)).toBe(0);
  release();
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(1);

  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    (window as any).decodeResolvers = [];
    HTMLImageElement.prototype.decode = function () {
      const image = this;
      return decode.call(this).then(() => image.src.includes("decode.png")
        ? new Promise<void>((resolve) => (window as any).decodeResolvers.push(resolve)) : undefined);
    };
    (window as any).canvasFixture.image("decode", "/canvas-images/decode.png");
  });
  await expect.poll(() => page.evaluate(() => (window as any).decodeResolvers.length)).toBeGreaterThan(0);
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(0);
  await page.evaluate(() => (window as any).canvasFixture.image("latest", "/canvas-images/latest.png"));
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(1);
  await page.evaluate(() => (window as any).decodeResolvers.forEach((resolve: () => void) => resolve()));
  await expect(page.locator(".mag-cv")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(1);
});

test("video hides annotations while lagging or when painting fails, then restores them", async ({ page }) => {
  await page.evaluate(() => (window as any).canvasFixture.bitmap("video:1", true));
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(0);
  await expect(page.locator(".mag-cv-lb, .mag-cv-ghost-hit")).toHaveCount(0);
  await page.evaluate(() => (window as any).canvasFixture.finishWaiting());
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(1);
  await page.evaluate(() => (window as any).canvasFixture.bitmap("video:2", false, true));
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(0);
  await page.evaluate(() => (window as any).canvasFixture.bitmap("video:3"));
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(1);
  await expect(page.locator(".mag-cv")).toHaveAttribute("aria-busy", "false");
});

test("an image load error keeps overlays hidden and a cached image can be reused", async ({ page }) => {
  await page.route("**/canvas-images/broken.png", (route) => route.abort());
  await page.evaluate(() => (window as any).canvasFixture.image("broken", "/canvas-images/broken.png"));
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(0);
  await expect(page.locator(".mag-cv")).toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => (window as any).canvasFixture.image("back", "/canvas-images/first.png"));
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(1);
  await page.evaluate(() => (window as any).canvasFixture.image("same-source-new-id", "/canvas-images/first.png"));
  await expect(page.locator(".mag-cv")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(1);
});

test("returning to an earlier frame waits for this load, not its old ready flag", async ({ page }) => {
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    (window as any).resolvers = [];
    HTMLImageElement.prototype.decode = function () {
      return decode.call(this).then(() => new Promise<void>((resolve) => (window as any).resolvers.push(resolve)));
    };
    (window as any).canvasFixture.image("second", "/canvas-images/second.png");
  });
  await expect.poll(() => page.evaluate(() => (window as any).resolvers.length)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).canvasFixture.image("first", "/canvas-images/first.png"));
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).resolvers.length)).toBeGreaterThan(1);
  await page.evaluate(() => (window as any).resolvers.forEach((resolve: () => void) => resolve()));
  await expect(page.locator(".mag-cv-sh:not(.mag-cv-ov)")).toHaveCount(1);
});
