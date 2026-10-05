import { describe, expect, it } from "vitest";
import { day, matchPeople, presence } from "./members";

const p = (display_name: string, login: string, role: string) => ({ user: { id: login, login, display_name }, role });
const rows = [p("Иван Соя", "ivan", "admin"), p("Пётр Ёлкин", "petr", "editor"), p("Мария", "masha", "viewer")];

describe("matchPeople", () => {
  it("ищет по имени и логину без регистра, ё = е", () => {
    expect(matchPeople(rows, "елкин", "all").map((r) => r.user.login)).toEqual(["petr"]);
    expect(matchPeople(rows, "MASH", "all").map((r) => r.user.login)).toEqual(["masha"]);
  });
  it("отбирает по роли вместе с запросом", () => {
    expect(matchPeople(rows, "", "editor").map((r) => r.user.login)).toEqual(["petr"]);
    expect(matchPeople(rows, "иван", "viewer")).toEqual([]);
  });
});

describe("presence", () => {
  const now = new Date("2026-10-05T12:00:00").getTime();
  it("в сети важнее давности", () => {
    expect(presence({ online: true, last_seen_at: "2026-10-01T10:00:00" }, now)).toBe("в сети");
  });
  it("давность и «не заходил(а)»", () => {
    expect(presence({ online: false, last_seen_at: "2026-10-05T10:00:00" }, now)).toBe("заходил(а) 2 часа назад");
    expect(presence({ online: false, last_seen_at: null }, now)).toBe("не заходил(а)");
  });
});

describe("day", () => {
  it("дата без точки и «г.»", () => {
    expect(day("2025-08-12T10:00:00")).toBe("12 авг 2025");
  });
});
