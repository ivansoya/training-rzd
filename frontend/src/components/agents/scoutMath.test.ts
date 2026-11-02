import { describe, expect, it } from "vitest";
import { clampView, clock, nearest, sampledCount, scoutColors, scoutStarts, timeTicks } from "./scoutMath";
import { nextFrame } from "../editor/review";

describe("счёт окон разведки", () => {
  it("переходит по началам участков выбранных классов, включая пересекающиеся", () => {
    const segments: Parameters<typeof scoutStarts>[0] = {
      "Мусор": [[100, 200, 3], [400, 450, 2]],
      "Человек": [[100, 150, 2], [175, 225, 3], [300, 350, 2]],
    };
    const starts = scoutStarts(segments, new Set());
    expect(starts).toEqual([100, 175, 300, 400]);
    expect(nextFrame(starts, 175, 1)).toBe(300);
    expect(nextFrame(starts, 400, 1)).toBe(100);
    expect(nextFrame(starts, 100, -1)).toBe(400);
    expect(scoutStarts(segments, new Set(["Человек"]))).toEqual([100, 400]);
    expect(scoutStarts(segments, new Set(Object.keys(segments)))).toEqual([]);
  });

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

  it("кадров к разметке — как agent_graph.sampled", () => {
    // sampled(last=29499, 25) — кадры 0, 25, …, 29475: 1180 штук
    expect(sampledCount(29500, 25)).toBe(1180);
    expect(sampledCount(29501, 25)).toBe(1181);   // кадр 29500 — тоже
    expect(sampledCount(1, 25)).toBe(1);
    expect(sampledCount(0, 25)).toBe(0);
    expect(sampledCount(10, 1)).toBe(10);
  });
});
