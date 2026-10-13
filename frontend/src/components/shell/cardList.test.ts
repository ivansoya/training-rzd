import { describe, expect, it } from "vitest";
import { cardList, loadOf } from "./useGpuState";

describe("cardList", () => {
  it("номера карт подряд — диапазоном, вразбивку — перечнем", () => {
    expect(cardList([1, 0])).toBe("0–1");
    expect(cardList([2, 3, 4])).toBe("2–4");
    expect(cardList([5, 2])).toBe("2, 5");
    expect(cardList([4])).toBe("4");
  });
});

describe("loadOf", () => {
  it("свободна от 30 %, загружена от 10 %, ниже — занята; карты нет — занята", () => {
    expect(loadOf(5632, 7831).label).toBe("свободна");
    expect(loadOf(2350, 7831).label).toBe("свободна");
    expect(loadOf(2340, 7831).label).toBe("загружена");
    expect(loadOf(784, 7831).label).toBe("загружена");
    expect(loadOf(780, 7831).label).toBe("занята");
    expect(loadOf(0, 0).label).toBe("занята");
  });
});
