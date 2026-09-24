import { describe, expect, it } from "vitest";
import { frameActions } from "./frameActions";

const f = (status: Parameters<typeof frameActions>[0]["status"], objects = 0, agentFrame = false, readOnly = false) =>
  frameActions({ status, objects, agentFrame, readOnly });

describe("плашка решений: только то, что можно нажать", () => {
  it.each([
    ["новый, без рамок", f("new"), ["empty", "skip", "trash", "next"]],
    ["новый, рамки агента", f("new", 3, true), ["accept", "skip", "trash", "next"]],
    ["размечен", f("annotated", 2), ["skip", "trash", "next"]],
    ["фоновый", f("empty"), ["empty", "skip", "trash", "next"]],
    ["отложен, объектов нет", f("skipped"), ["empty", "skip", "trash", "next"]],
    ["отложен, объекты есть", f("skipped", 1), ["skip", "trash", "next"]],
    ["забракован", f("deleted", 2), ["restore", "next"]],
    ["таска закрыта", f("annotated", 2, false, true), ["next"]],
  ])("%s", (_name, got, want) => {
    expect(got).toEqual(want);
  });
});
