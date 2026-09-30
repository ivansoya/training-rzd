import { describe, expect, it } from "vitest";
import { keyAction, record, redo, start, undo } from "./history";

describe("история правок графа", () => {
  it("отмена и повтор ходят по записанному", () => {
    let h = record(record(start("a"), "b"), "c");
    let got: string | null;
    [h, got] = undo(h, "c");
    expect(got).toBe("b");
    [h, got] = undo(h, "b");
    expect(got).toBe("a");
    [h, got] = undo(h, "a");
    expect(got).toBeNull();
    [h, got] = redo(h, "a");
    expect(got).toBe("b");
    [h, got] = redo(h, "b");
    expect(got).toBe("c");
    [, got] = redo(h, "c");
    expect(got).toBeNull();
  });

  it("незаписанная правка не теряется: отмена возвращает к записанному, повтор — к ней", () => {
    let h = start("a");
    let got: string | null;
    [h, got] = undo(h, "a+правка");
    expect(got).toBe("a");
    [, got] = redo(h, "a");
    expect(got).toBe("a+правка");
  });

  it("правка после отмены стирает «вперёд»", () => {
    let h = record(start("a"), "b");
    [h] = undo(h, "b");
    const [, got] = redo(h, "x");
    expect(got).toBeNull();
    expect(record(h, "x").future).toEqual([]);
  });

  it("повтор того же состояния не пишется, глубина ограничена", () => {
    const h = start("a");
    expect(record(h, "a")).toBe(h);
    let long = start("0");
    for (let i = 1; i <= 150; i++) long = record(long, String(i));
    expect(long.past.length).toBe(100);
    expect(long.past[0]).toBe("50");
  });

  it("клавиши: по коду, в любой раскладке", () => {
    const k = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
      keyAction({ code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
    expect(k("KeyZ", { ctrlKey: true })).toBe("undo");
    expect(k("KeyZ", { ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(k("KeyY", { ctrlKey: true })).toBe("redo");
    expect(k("KeyZ", { metaKey: true })).toBe("undo");
    expect(k("KeyZ")).toBeNull();
    expect(k("KeyZ", { ctrlKey: true, altKey: true })).toBeNull();
  });
});
