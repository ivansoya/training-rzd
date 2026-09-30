import { describe, expect, it } from "vitest";
import { clampView, clock, nearest, scoutColors, timeTicks } from "./scoutMath";

describe("счёт окон разведки", () => {
  it("время ролика", () => {
    expect(clock(59.9)).toBe("0:59");
    expect(clock(725)).toBe("12:05");
    expect(clock(3725)).toBe("1:02:05");
  });

  it("ближайший проверенный кадр", () => {
    const checked = [0, 25, 50, 75];
    expect(nearest(checked, -10)).toBe(0);
    expect(nearest(checked, 37)).toBe(1);
    expect(nearest(checked, 38)).toBe(2);
    expect(nearest(checked, 999)).toBe(3);
  });

  it("отметки шкалы круглые и не у краёв", () => {
    expect(timeTicks(0, 1499, 25)).toEqual([10, 20, 30, 40, 50]);
    // окно 2:00–4:00 на 25 к/с — шаг 30 с
    expect(timeTicks(3000, 6000, 25)).toEqual([150, 180, 210]);
  });

  it("окно не выходит за ролик и не уже предела", () => {
    expect(clampView(-50, 100, 1000, 30)).toEqual({ a: 0, b: 100 });
    expect(clampView(950, 100, 1000, 30)).toEqual({ a: 900, b: 1000 });
    expect(clampView(10, 5, 1000, 30)).toEqual({ a: 10, b: 40 });
    expect(clampView(0, 5000, 1000, 30)).toEqual({ a: 0, b: 1000 });
  });

  it("цвет класса один на всю таску", () => {
    const c = scoutColors(["Человек", "металл", "Человек", "Инструмент"]);
    expect([...c.keys()]).toEqual(["Инструмент", "металл", "Человек"]);
    expect(c.get("Человек")).not.toBe(c.get("металл"));
  });
});
