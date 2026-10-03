import { describe, expect, it } from "vitest";
import { parseTime } from "./VideoCutModal";

describe("время участка нарезки", () => {
  it("понимает минуты, доли и голые секунды", () => {
    expect(parseTime("1:05", 600_000)).toBe(65_000);
    expect(parseTime("1:05.25", 600_000)).toBe(65_250);
    expect(parseTime("65,5", 600_000)).toBe(65_500);
    expect(parseTime("0.5", 600_000)).toBe(500);
  });
  it("недонабранное — не ноль, а отказ", () => {
    for (const text of ["", "0:", "1:7x", "1:75"]) expect(parseTime(text, 600_000)).toBeNull();
  });
  it("не дальше конца ролика", () => {
    expect(parseTime("9:00", 3_000)).toBe(3_000);
  });
});
