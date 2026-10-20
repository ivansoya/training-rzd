import { describe, expect, it } from "vitest";
import { enqueueUpload, uploadOf, uploading } from "./uploads";

/**
 * Загрузка ушла из страницы в очередь вкладки (voran, 20.10.2026): шесть роликов
 * грузились дальше после ухода в другой раздел, а вернувшийся хода не видел.
 * Здесь — то, что держит очередь честной: партии не делят канал, отказ снимает
 * только свою партию, счёт сходится.
 */

/** Отправка, которую тест завершает сам. */
function gate() {
  let done!: () => void;
  let fail!: (e: Error) => void;
  const started = { value: false };
  const send = () => {
    started.value = true;
    return new Promise<string>((res, rej) => { done = () => res("ok"); fail = rej; });
  };
  return { send, started, done: () => done(), fail: (m: string) => fail(new Error(m)) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("очередь загрузок", () => {
  it("вторая партия ждёт первую, счёт растёт, по концу полосы нет", async () => {
    const a = gate(), b = gate(), c = gate();
    const first = enqueueUpload("t1", [{ name: "a.mp4", send: a.send }, { name: "b.mp4", send: b.send }]);
    const second = enqueueUpload("t1", [{ name: "c.mp4", send: c.send }]);
    await tick();
    expect(uploadOf("t1")).toMatchObject({ name: "a.mp4", done: 0, total: 3 });
    a.done(); await tick();
    expect(c.started.value).toBe(false);
    b.done(); await first;
    await tick();
    expect(c.started.value).toBe(true);
    expect(uploadOf("t1")).toMatchObject({ name: "c.mp4", done: 2, total: 3 });
    c.done(); await second;
    expect(uploading(uploadOf("t1"))).toBe(false);
    expect(uploadOf("t1")?.landed).toBe(3);
  });

  it("отказ снимает остаток своей партии, чужая идёт", async () => {
    const x = gate(), y = gate(), z = gate();
    const first = enqueueUpload("t2", [{ name: "x.mp4", send: x.send }, { name: "y.mp4", send: y.send }]);
    const second = enqueueUpload("t2", [{ name: "z.mp4", send: z.send }]);
    await tick();
    x.fail("«x.mp4» не читается как видео.");
    await expect(first).rejects.toThrow("не читается");
    await tick();
    expect(y.started.value).toBe(false);
    expect(uploadOf("t2")).toMatchObject({ total: 1, done: 0, error: "«x.mp4» не читается как видео.", name: "z.mp4" });
    z.done(); await second;
    expect(uploadOf("t2")).toMatchObject({ done: 1, total: 1, landed: 1 });
    expect(uploadOf("t2")?.error).toBeTruthy();
  });
});
