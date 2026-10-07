import { describe, expect, it } from "vitest";
import { frameActions } from "./frameActions";

const f = (status: Parameters<typeof frameActions>[0]["status"], objects = 0, readOnly = false) =>
  frameActions({ status, objects, readOnly });

describe("плашка решений: только то, что можно нажать", () => {
  it.each([
    ["новый, без рамок", f("new"), ["empty", "skip", "trash", "next"]],
    // Рамки агента проверяются плашкой над панелью, «Пусто» при объектах нет
    ["новый, рамки агента", f("new", 3), ["skip", "trash", "next"]],
    ["размечен", f("annotated", 2), ["skip", "trash", "next"]],
    ["фоновый", f("empty"), ["empty", "skip", "trash", "next"]],
    ["отложен, объектов нет", f("skipped"), ["empty", "skip", "trash", "next"]],
    ["отложен, объекты есть", f("skipped", 1), ["skip", "trash", "next"]],
    ["забракован", f("deleted", 2), ["restore", "next"]],
    ["таска закрыта", f("annotated", 2, true), ["next"]],
  ])("%s", (_name, got, want) => {
    expect(got).toEqual(want);
  });
});
