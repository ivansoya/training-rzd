import { describe, expect, it } from "vitest";
import { dropNoop, empty, peek, record, redo, undo } from "./editHistory";

describe("история правок кадра", () => {
  it("отмена и повтор ходят по снимкам в обе стороны", () => {
    let h = empty<string>();
    h = record(h, "a");            // a → b
    h = record(h, "b");            // b → c
    const u1 = undo(h, "c")!;
    expect(u1.value).toBe("b");
    const u2 = undo(u1.h, "b")!;
    expect(u2.value).toBe("a");
    expect(undo(u2.h, "a")).toBeNull();
    const r1 = redo(u2.h, "a")!;
    expect(r1.value).toBe("b");
    expect(redo(r1.h, "b")!.value).toBe("c");
  });

  it("новая правка после отмены обрывает повтор", () => {
    let h = record(empty<string>(), "a");
    const u = undo(h, "b")!;
    h = record(u.h, "a");          // правка вместо повтора
    expect(redo(h, "x")).toBeNull();
  });

  it("стек ограничен и теряет самые старые снимки", () => {
    let h = empty<number>();
    for (let i = 0; i < 10; i++) h = record(h, i, 3);
    expect(h.past).toEqual([7, 8, 9]);
  });

  it("пустой жест не оставляет шага", () => {
    const h = record(empty<number[]>(), [1]);
    const same = (a: number[], b: number[]) => JSON.stringify(a) === JSON.stringify(b);
    expect(dropNoop(h, [1], same).past).toEqual([]);
    expect(dropNoop(h, [2], same).past).toEqual([[1]]);
  });

  it("сквозь кадры: шаг знает свой кадр — отмена ведёт туда, а не откатывает здешний", () => {
    type Snap = { at: string; v: number };
    let h = record(empty<Snap>(), { at: "кадр 1", v: 1 });  // «Отклонить» на кадре 1
    h = record(h, { at: "кадр 2", v: 5 });                     // правка на кадре 2
    expect(peek(h, "undo")?.at).toBe("кадр 2");
    const u = undo(h, { at: "кадр 2", v: 6 })!;
    expect(peek(u.h, "undo")?.at).toBe("кадр 1");
    expect(peek(u.h, "redo")).toEqual({ at: "кадр 2", v: 6 });
    expect(peek(empty<Snap>(), "undo")).toBeUndefined();
  });
});
