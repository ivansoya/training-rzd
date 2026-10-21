import { describe, expect, it } from "vitest";
import { STALE_MS, hereNames, hereOn, hereSweep, type Here } from "./here";

const people = [{ id: "a", display_name: "Пётр" }, { id: "b", display_name: "Анна" }];

describe("присутствие в ролике", () => {
  it("пульс добавляет, «off» убирает, пустой ролик исчезает", () => {
    let h: Here = {};
    h = hereOn(h, { id: "v1", u: "a" }, 0);
    h = hereOn(h, { id: "v1", u: "b" }, 0);
    expect(hereNames(h, "v1", people)).toEqual(["Анна", "Пётр"]);
    h = hereOn(h, { id: "v1", u: "a", s: "off" }, 1);
    h = hereOn(h, { id: "v1", u: "b", s: "off" }, 1);
    expect(h).toEqual({});
  });

  it("минута без пульса — ушёл; свежий остаётся", () => {
    let h: Here = {};
    h = hereOn(h, { id: "v1", u: "a" }, 0);
    h = hereOn(h, { id: "v2", u: "b" }, 30_000);
    h = hereSweep(h, STALE_MS);
    expect(hereNames(h, "v1", people)).toEqual([]);
    expect(hereNames(h, "v2", people)).toEqual(["Анна"]);
  });

  it("без ушедших — тот же объект, без лишней перерисовки", () => {
    const h = hereOn({}, { id: "v1", u: "a" }, 0);
    expect(hereSweep(h, 1000)).toBe(h);
  });
});
