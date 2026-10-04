import { describe, expect, it } from "vitest";
import { searchItems } from "./search";
import type { SearchItem } from "./search";

const it_ = (group: string, label: string, hint?: string): SearchItem => ({ group, label, hint, to: "/", icon: "tag" });

describe("поиск по сайту", () => {
  const items = [
    it_("Разделы", "Таски"),
    it_("Таски", "Перегон Ш-12, утро"),
    it_("Таски", "Утренний обход"),
    it_("Классы", "Ёлка"),
    it_("Классы", "Вагон", "подвижной состав"),
  ];

  it("пустой запрос — пусто", () => {
    expect(searchItems("  ", items)).toEqual([]);
  });

  it("начало слова раньше вхождения, группы в исходном порядке", () => {
    expect(searchItems("утр", items).map((i) => i.label)).toEqual(["Утренний обход", "Перегон Ш-12, утро"]);
  });

  it("ё и е не различаются, подсказка тоже ищется", () => {
    expect(searchItems("елка", items).map((i) => i.label)).toEqual(["Ёлка"]);
    expect(searchItems("подвижной", items).map((i) => i.label)).toEqual(["Вагон"]);
  });

  it("не больше заданного на группу", () => {
    const many = Array.from({ length: 10 }, (_, i) => it_("Таски", `таска ${i}`));
    expect(searchItems("таска", many, 3)).toHaveLength(3);
  });
});
