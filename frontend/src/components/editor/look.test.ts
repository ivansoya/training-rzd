import { describe, expect, it } from "vitest";
import { digitClass, filterClasses, inkOn, progressOf, stagePad, statusLook } from "./look";

describe("текст на цвете класса", () => {
  it("на ярко-зелёном и жёлтом — тёмный, на тёмно-красном и синем — светлый", () => {
    expect(inkOn("#00d810")).toBe("dark");
    expect(inkOn("#ffc53d")).toBe("dark");
    expect(inkOn("#6d0000")).toBe("light");
    expect(inkOn("#1f6feb")).toBe("light");
  });

  it("непонятный цвет — светлый текст", () => {
    expect(inkOn("red")).toBe("light");
  });
});

describe("прогресс по списку кадров", () => {
  it("решено — размечен, пусто и брак; отложенный ждёт", () => {
    const p = progressOf([
      { task_status: "annotated" }, { task_status: "empty" }, { task_status: "deleted" },
      { task_status: "skipped" }, { task_status: "new" },
    ]);
    expect(p.decided).toBe(3);
    expect(p.total).toBe(5);
    expect(p.pct).toBeCloseTo(0.6);
    expect(p.counts.skipped).toBe(1);
  });

  it("пустой список — ноль, а не NaN", () => {
    expect(progressOf([]).pct).toBe(0);
  });

  it("незнакомое состояние считается нетронутым", () => {
    expect(progressOf([{ task_status: "что-то" }]).counts.new).toBe(1);
    expect(statusLook("что-то").id).toBe("new");
  });
});

describe("поля сцены", () => {
  it("с панелями кадр встаёт между лентой и правой панелью", () => {
    const p = stagePad({ panels: true, film: 112, side: 280 });
    expect(p.left).toBeGreaterThan(112);
    expect(p.right).toBeGreaterThan(280);
  });

  it("без панелей — во весь экран", () => {
    const p = stagePad({ panels: false, film: 112, side: 280 });
    expect(Math.max(p.left, p.right, p.top, p.bottom)).toBeLessThan(40);
  });
});

describe("классы", () => {
  const list = [
    { name: "Вагон", class_index: 0 }, { name: "Гайка", class_index: 3 }, { name: "Вагонетка", class_index: 7 },
  ];

  it("цифра — место в списке проекта", () => {
    expect(digitClass(list, "Digit2")?.name).toBe("Гайка");
    expect(digitClass(list, "Digit9")).toBeUndefined();
    expect(digitClass(list, "KeyA")).toBeUndefined();
  });

  it("поиск по имени без регистра и по номеру", () => {
    expect(filterClasses(list, "ваг").map((c) => c.class_index)).toEqual([0, 7]);
    expect(filterClasses(list, "3").map((c) => c.name)).toEqual(["Гайка"]);
    expect(filterClasses(list, "  ")).toHaveLength(3);
  });
});
