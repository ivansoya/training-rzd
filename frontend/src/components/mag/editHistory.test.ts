import { describe, expect, it } from "vitest";
import { at, dropNoop, dropTransient, empty, peek, put, record, redo, undo } from "./editHistory";
import type { ByFrame } from "./editHistory";

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

  it("шаг закреплён за кадром: на другом кадре отменять нечего", () => {
    let m: ByFrame<string, number> = new Map();
    m = put(m, "кадр 1", record(at(m, "кадр 1"), 1));           // «Отклонить» на кадре 1
    m = put(m, "кадр 2", record(at(m, "кадр 2"), 5));           // правка на кадре 2
    const u = undo(at(m, "кадр 2"), 6)!;
    expect(u.value).toBe(5);
    m = put(m, "кадр 2", u.h);
    expect(undo(at(m, "кадр 2"), 5)).toBeNull();                // кадр 1 отсюда не достать
    expect(undo(at(m, "кадр 3"), 0)).toBeNull();
    expect(undo(at(m, "кадр 1"), 2)!.value).toBe(1);            // а на своём кадре — пожалуйста
    expect(peek(at(m, "кадр 2"), "redo")).toBe(6);
    expect(peek(empty<number>(), "undo")).toBeUndefined();
  });

  it("пустая история кадра не хранится, лишние кадры забываются с самых давних", () => {
    let m: ByFrame<number, number> = new Map();
    for (let f = 0; f < 5; f++) m = put(m, f, record(empty<number>(), f), 3);
    expect([...m.keys()]).toEqual([2, 3, 4]);
    m = put(m, 2, record(at(m, 2), 9), 3);                       // тронули — стал свежим
    m = put(m, 5, record(empty<number>(), 5), 3);
    expect([...m.keys()]).toEqual([4, 2, 5]);
    m = put(m, 4, empty<number>(), 3);
    expect(m.has(4)).toBe(false);
  });

  it("брошенное выделение полуавтомата не оставляет шагов", () => {
    type S = { boxes: string; sel: string | null };
    const same = (a: S, b: S) => a.boxes === b.boxes;
    const transient = (s: S) => s.sel !== null;
    let h = record(empty<S>(), { boxes: "a", sel: null });       // правка a → b
    h = record(h, { boxes: "b", sel: null });                    // щелчок SAM2
    h = record(h, { boxes: "b", sel: "точка 1" });               // второй щелчок
    const u = undo(h, { boxes: "b", sel: "точка 2" })!;          // отменили второй
    const left = dropTransient(u.h, { boxes: "b", sel: null }, same, transient);
    expect(left.past).toEqual([{ boxes: "a", sel: null }]);      // осталась только правка
    expect(left.future).toEqual([]);
    expect(dropTransient(left, { boxes: "b", sel: null }, same, transient)).toBe(left);
    // Повтор без изменения разметки — пустой шаг; повтор настоящей правки остаётся
    const back = { past: [], future: [{ boxes: "b", sel: null }, { boxes: "c", sel: null }] };
    expect(dropTransient(back, { boxes: "b", sel: null }, same, transient).future).toEqual([{ boxes: "c", sel: null }]);
  });
});
