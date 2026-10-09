import { describe, expect, it } from "vitest";
import {
  agentGroups, confirmAll, confirmWhere, isTaken, nearestTick, nextFlagged, nextFrame, pendingCount, rejectAll, rejectWhere,
  scoutFrameAt, settlePending,
} from "./review";

const box = (id: string, pending = true, x = 10) => ({ id, class_index: 1, x, y: 10, w: 50, h: 40, pending });

describe("проверка разметки агента", () => {
  it("правка снимает проверку только с правленой рамки", () => {
    const prev = [box("a"), box("b")];
    const next = settlePending(prev, [prev[0], { ...prev[1], x: 12 }]);
    expect(next.map((s) => s.pending)).toEqual([true, false]);
  });

  it("перекраска — тоже правка", () => {
    const prev = [box("a")];
    expect(settlePending(prev, [{ ...prev[0], class_index: 2 }])[0].pending).toBe(false);
  });

  it("копия непроверенной — своя рамка", () => {
    const prev = [box("a")];
    expect(settlePending(prev, [prev[0], { ...prev[0] }]).map((s) => s.pending)).toEqual([true, false]);
  });

  it("без правок список тот же", () => {
    const prev = [box("a"), box("b", false)];
    expect(settlePending(prev, prev)).toBe(prev);
  });

  it("подтвердить и отклонить все", () => {
    const list = [box("a"), box("b", false), box("c")];
    expect(pendingCount(confirmAll(list))).toBe(0);
    expect(rejectAll(list).map((s) => s.id)).toEqual(["b"]);
  });
});

describe("переход к следующему на проверке", () => {
  it("вперёд по кругу, своя позиция — последней", () => {
    const f = [false, true, false, true];
    expect(nextFlagged(f, 1, 1)).toBe(3);
    expect(nextFlagged(f, 3, 1)).toBe(1);
    expect(nextFlagged(f, 1, -1)).toBe(3);
    expect(nextFlagged([false, true], 1, 1)).toBe(1);
    expect(nextFlagged([false, false], 0, 1)).toBeNull();
  });

  it("кадры ролика", () => {
    const f = [25, 50, 75];
    expect(nextFrame(f, 30, 1)).toBe(50);
    expect(nextFrame(f, 75, 1)).toBe(25);
    expect(nextFrame(f, 30, -1)).toBe(25);
    expect(nextFrame(f, 25, -1)).toBe(75);
    expect(nextFrame([25], 25, 1)).toBeNull();
    expect(nextFrame([], 0, 1)).toBeNull();
  });
});

describe("дорожки и призраки", () => {
  it("ближайшая риска в радиусе", () => {
    expect(nearestTick([10, 30, 34], 31)).toBe(1);
    expect(nearestTick([10, 30], 60)).toBeNull();
  });

  it("взятая находка призраком не рисуется", () => {
    const boxes = [{ class_index: 1, x: 10, y: 10, w: 100, h: 50 }];
    expect(isTaken({ class_index: 1, x: 40, y: 10, w: 100, h: 50 }, boxes)).toBe(true);
    expect(isTaken({ class_index: 2, x: 40, y: 10, w: 100, h: 50 }, boxes)).toBe(false);
    expect(isTaken({ class_index: null, x: 40, y: 10, w: 100, h: 50 }, boxes)).toBe(false);
    // Взяли другим классом или несопоставленную — рамка ровно на месте находки
    expect(isTaken({ class_index: 2, x: 10, y: 10, w: 100, h: 50 }, [{ class_index: 1, x: 10, y: 10, w: 100, h: 50 }])).toBe(true);
    expect(isTaken({ class_index: null, x: 10, y: 10, w: 100, h: 50 }, [{ class_index: 3, x: 11, y: 10, w: 100, h: 50 }])).toBe(true);
  });
});

describe("находки разведки при проигрывании", () => {
  it("на паузе — только сам проверенный кадр", () => {
    expect(scoutFrameAt([0, 25, 50], 25, false, 12)).toBe(25);
    expect(scoutFrameAt([0, 25, 50], 26, false, 12)).toBeNull();
  });
  it("при проигрывании — ближайший в пределах удержания", () => {
    expect(scoutFrameAt([0, 25, 50], 33, true, 12)).toBe(25);
    expect(scoutFrameAt([0, 25, 50], 38, true, 12)).toBe(50);
    expect(scoutFrameAt([0, 50], 25, true, 12)).toBeNull();
  });
});

describe("рамки нескольких агентов на кадре", () => {
  const b = (id: string, pending: boolean) => ({ id, class_index: 0, x: 0, y: 0, w: 1, h: 1, pending });
  const by: Record<string, string> = { a: "YOLOE", b: "SAM3", c: "YOLOE" };
  const agentOf = (s: { id?: string }) => (s.id && by[s.id] ? { key: by[s.id], name: by[s.id], version: 1 } : null);
  const list = [b("a", true), b("b", true), b("c", true), b("d", false)];

  it("группы по агенту в порядке появления, проверенное не в счёт", () => {
    expect(agentGroups(list, agentOf).map((g) => [g.agent.key, g.idx])).toEqual([["YOLOE", [0, 2]], ["SAM3", [1]]]);
  });

  it("принять и отклонить только своё агента", () => {
    const yoloe = (s: { id?: string }) => agentOf(s)?.key === "YOLOE";
    expect(confirmWhere(list, yoloe).map((s) => s.pending)).toEqual([false, true, false, false]);
    expect(rejectWhere(list, yoloe).map((s) => s.id)).toEqual(["b", "d"]);
  });
});
