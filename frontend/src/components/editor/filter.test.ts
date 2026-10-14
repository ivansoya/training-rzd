import { describe, expect, it } from "vitest";
import { agentShown, classKey, countClasses, frameShown } from "./filter";

describe("фильтр классов", () => {
  const off = new Set([classKey(1), classKey(2)]);

  it("кадр проходит по любому неснятому классу, пустой при фильтре выпадает", () => {
    expect(frameShown([{ class_index: 1 }, { class_index: 3 }], off)).toBe(true);
    expect(frameShown([{ class_index: 1 }, { class_index: 2 }], off)).toBe(false);
    expect(frameShown([], off)).toBe(false);
    expect(frameShown([], new Set())).toBe(true);
  });

  it("риска агента гаснет, только когда сняты все её классы", () => {
    expect(agentShown([1, 2], off)).toBe(false);
    expect(agentShown([2, 4], off)).toBe(true);
    expect(agentShown(undefined, off)).toBe(true);
  });

  it("счёт по классам", () => {
    expect([...countClasses([3, 1, 3])]).toEqual([[3, 2], [1, 1]]);
  });
});
