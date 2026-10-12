import { describe, expect, it } from "vitest";
import { chunkAt, chunkPlan, nextChunk } from "./chunks";

describe("куски разметки ролика", () => {
  it("режутся по числу рамок на границе кадра и покрывают весь ролик", () => {
    const marks: [number, number, number][] = [[0, 9, 9], [25, 10, 9], [50, 11, 0], [75, 9, 9], [100, 10, 10]];
    // 9+10 ≥ 15 — режем перед кадром 50; 11+9 ≥ 15 — перед 100; хвост — до конца ролика
    expect(chunkPlan(marks, 120, 15)).toEqual([{ from: 0, to: 50 }, { from: 50, to: 100 }, { from: 100, to: 121 }]);
    // Кадр не делится, даже если на нём больше лимита
    expect(chunkPlan([[5, 5000, 0]], 10, 1500)).toEqual([{ from: 0, to: 11 }]);
  });

  it("без одиночных рамок грузить нечего", () => {
    expect(chunkPlan([], 1000)).toEqual([]);
    expect(nextChunk([], new Set(), 3)).toBeNull();
  });

  it("сначала кусок указателя, дальше к концу, потом с начала", () => {
    const chunks = [{ from: 0, to: 10 }, { from: 10, to: 20 }, { from: 20, to: 30 }, { from: 30, to: 40 }];
    const loaded = new Set<number>();
    const order: number[] = [];
    for (let i = nextChunk(chunks, loaded, 25); i !== null; i = nextChunk(chunks, loaded, 25)) { order.push(i); loaded.add(i); }
    expect(order).toEqual([2, 3, 0, 1]);
    expect(chunkAt(chunks, 39)).toBe(3);
  });

  it("перемотка в незагруженное ставит его кусок следующим", () => {
    const chunks = [{ from: 0, to: 10 }, { from: 10, to: 20 }, { from: 20, to: 30 }];
    expect(nextChunk(chunks, new Set([0]), 15)).toBe(1);
    expect(nextChunk(chunks, new Set([1]), 15)).toBe(2);
  });
});
