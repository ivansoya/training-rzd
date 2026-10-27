import { describe, expect, it } from "vitest";
import { draggedOf, fits, kindOf, parts, zoneSay } from "./drop";

/** Перетаскивание файлов в таску (решения 27.10.2026): зона берёт только свой род, папка до броска непрозрачна,
 *  изображения уходят частями ≤ 200 файлов и ≤ 512 МБ. */

const item = (type: string) => ({ kind: "file", type });

describe("род файла", () => {
  it("по типу, а без типа — по расширению", () => {
    expect(kindOf({ name: "a.jpg", type: "image/jpeg" })).toBe("images");
    expect(kindOf({ name: "cam1.mp4", type: "video/mp4" })).toBe("videos");
    expect(kindOf({ name: "cam1.h265", type: "" })).toBe("videos");
    expect(kindOf({ name: "shot.TIFF", type: "" })).toBe("images");
    expect(kindOf({ name: "notes.txt", type: "text/plain" })).toBeNull();
  });
});

describe("зоны, пока тащат", () => {
  it("одни ролики: изображения гаснут, над видео-зоной — число и куда", () => {
    const d = draggedOf([item("video/mp4"), item("video/mp4"), item("video/mp4")]);
    expect(fits("images", d)).toBe(false);
    expect(zoneSay("images", d, false)).toBe("Сюда — только изображения");
    expect(zoneSay("cut", d, true)).toBe("Отпустите — 3 ролика на нарезку");
    expect(zoneSay("annotate", d, false)).toBe("");
  });

  it("смесь — светятся все, над зоной честно: возьму только свой род", () => {
    const d = draggedOf([item("image/png"), item("video/mp4")]);
    expect(fits("images", d) && fits("cut", d) && fits("annotate", d)).toBe(true);
    expect(zoneSay("annotate", d, true)).toBe("Отпустите — возьму только ролики");
  });

  it("папка (тип пустой) — гасить нечего", () => {
    const d = draggedOf([item(""), { kind: "string", type: "text/plain" }]);
    expect(d.unknown).toBe(true);
    expect(fits("images", d) && fits("cut", d)).toBe(true);
    expect(zoneSay("images", d, true)).toBe("Отпустите — возьму только изображения");
  });
});

describe("изображения частями", () => {
  const mb = (n: number) => ({ size: n * 2 ** 20 });

  it("по 200 файлов", () => {
    expect(parts(Array.from({ length: 450 }, () => mb(1)))).toEqual([[0, 200], [200, 400], [400, 450]]);
  });

  it("по 512 МБ, а файл крупнее предела идёт один", () => {
    expect(parts([mb(300), mb(300), mb(700), mb(10)])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
    expect(parts([mb(200), mb(200), mb(100)])).toEqual([[0, 3]]);
  });

  it("пусто — ни одной части", () => {
    expect(parts([])).toEqual([]);
  });
});
