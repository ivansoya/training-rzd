import { describe, expect, it } from "vitest";
import { cardList } from "./useGpuState";

describe("cardList", () => {
  it("номера карт подряд — диапазоном, вразбивку — перечнем", () => {
    expect(cardList([1, 0])).toBe("0–1");
    expect(cardList([2, 3, 4])).toBe("2–4");
    expect(cardList([5, 2])).toBe("2, 5");
    expect(cardList([4])).toBe("4");
  });
});
