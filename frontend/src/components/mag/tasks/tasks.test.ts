import { describe, expect, it } from "vitest";
import type { TaskCounts, TaskDetail, TaskLight, TaskStats } from "../../../auth/api";
import { boardColumns, buildSources, closePlan, closeText, dayOf, percentOf, requestOrder, sourceLine, teamLine, waitingOf } from "./tasks";

const video = (id: string, mode: string, created = "2026-10-01T10:00:00Z") =>
  ({ id, mode, file_name: `${id}.mp4`, created_at: created, segments: [] }) as never;

const counts = (c: Partial<TaskCounts>): TaskCounts =>
  ({ total: 0, new: 0, skipped: 0, annotated: 0, empty: 0, deleted: 0, accepted: 0, ...c });

const card = (id: string, status: string, o: Partial<TaskLight> = {}) => ({
  id, name: id, status, assignees: [], status_at: "2026-10-01T00:00:00Z", last_at: "2026-10-01T00:00:00Z", ...o,
}) as TaskLight;
const stats = (c: Partial<TaskCounts>) => ({ counts: counts(c) }) as TaskStats;

describe("источники таски", () => {
  it("закрытая разметка ролика даёт свой блок с кадрами агента", () => {
    const task = {
      videos: [video("v1", "annotate"), video("v2", "annotate")],
      sources: { v1: { total: 16, frames: 16, first_at: null } },
    } as unknown as TaskDetail;
    const blocks = buildSources(task, { v1: { new: 16, agent: 16 } });
    expect(blocks.map((b) => b.key)).toEqual(["v1"]);
    expect(blocks[0]).toMatchObject({ kind: "annotate", total: 16, known: true, title: "Из разметки «v1.mp4»" });
  });

  it("блоки встают по лёгкой части, числа — когда придут", () => {
    const task = {
      videos: [video("v1", "annotate")],
      sources: { v1: { total: 16, frames: 15, first_at: null }, files: { total: 2, frames: 0, first_at: "2026-09-01T00:00:00Z" } },
    } as unknown as TaskDetail;
    // Блок из одного брака остаётся; число кадров — без брака и сразу
    const blocks = buildSources(task, null);
    expect(blocks.map((b) => [b.key, b.known, b.total])).toEqual([["files", false, 0], ["v1", false, 15]]);
  });

  it("ролики на нарезку — один блок с суммой, даже ненарезанные", () => {
    const task = {
      videos: [video("a", "cut", "2026-10-02T00:00:00Z"), video("b", "cut")],
      sources: { a: { total: 3, frames: 3 }, b: { total: 4, frames: 4 }, files: { total: 1, frames: 1, first_at: "2026-09-01T00:00:00Z" } },
    } as unknown as TaskDetail;
    const [files, cut] = buildSources(task, { a: { new: 3, agent: 2 }, b: { annotated: 4 }, files: { new: 1 } });
    expect(files.key).toBe("files");
    expect(cut).toMatchObject({ kind: "cut", total: 7 });
    expect(cut.counts.agent).toBe(2);
  });
});

describe("доля решённого", () => {
  it("вниз и без брака", () => {
    expect(percentOf({ annotated: 299, empty: 0, new: 1, deleted: 50 })).toBe(99);
    expect(percentOf({})).toBe(0);
  });
});

describe("закрытие", () => {
  it("принимает решённое, удаляет черновики и ролики", () => {
    const p = closePlan(counts({ total: 10, annotated: 5, empty: 1, new: 4, deleted: 2, accepted: 2 }), 1);
    expect(p).toEqual({ accept: 4, drafts: 6, videos: 1 });
    expect(closeText(p, "Ш-12")).toEqual([
      "4 размеченных кадра уйдут в датасет «Ш-12».",
      "Будут удалены 6 черновых кадров и исходное видео — это необратимо.",
    ]);
  });
});

describe("доска", () => {
  it("раскладывает по состояниям, свежее сверху, фильтр «мои» и поиск", () => {
    const tasks = [
      card("old", "in_progress", { last_at: "2026-09-01T00:00:00Z", assignees: [{ id: "ты", display_name: "Ты" }, { id: "me", display_name: "Я" }] }),
      card("new", "in_progress", { last_at: "2026-10-03T00:00:00Z" }),
      card("arch", "closed"),
    ];
    const all = boardColumns(tasks, "", null);
    expect(all.cols.in_progress.map((t) => t.id)).toEqual(["new", "old"]);
    expect(all.cols.closed).toHaveLength(1);
    expect(boardColumns(tasks, "", "me").shown).toBe(1);
    expect(boardColumns(tasks, "ARC", null).cols.closed).toHaveLength(1);
  });

  it("исполнители строкой, пустой состав — ничья", () => {
    expect(teamLine([{ display_name: "Петров" }, { display_name: "Сидоров" }])).toBe("Петров, Сидоров");
    expect(teamLine([])).toBe("ничья");
  });

  it("ждут решения — только незакрытые", () => {
    const tasks = [card("a", "in_progress"), card("b", "closed"), card("c", "queued")];
    // У «c» счётчиков ещё нет — считаем то, что пришло
    expect(waitingOf(tasks, { a: stats({ new: 3, skipped: 2 }), b: stats({ new: 9 }) })).toBe(5);
  });

  it("порядок опроса: мои → «В работе» → остальные по доске → закрытые", () => {
    const me = { id: "me", display_name: "Я" };
    const tasks = [
      card("q1", "queued", { last_at: "2026-10-03T00:00:00Z" }),
      card("arch", "closed", { assignees: [me] }),
      card("w1", "in_progress"),
      card("d-mine", "done", { assignees: [me] }),
      card("q-mine", "queued", { assignees: [me], last_at: "2026-09-01T00:00:00Z" }),
      card("upd", "updating"),
    ];
    expect(requestOrder(tasks, "me")).toEqual(["q-mine", "d-mine", "w1", "q1", "upd", "arch"]);
  });

  it("строка источников", () => {
    expect(sourceLine({ files: 640, cut: 3, uncut: 1, annotate: 2 }))
      .toBe("640 изображений · 3 ролика на нарезку (1 не нарезан) · 2 ролика на разметку");
    expect(sourceLine({ files: 0, cut: 0, uncut: 0, annotate: 0 })).toBe("пустая");
  });
});

describe("даты", () => {
  it("сегодня — временем, прошлый год — с годом", () => {
    const now = new Date(2026, 9, 5, 12);
    expect(dayOf(new Date(2026, 8, 28).toISOString(), now)).toBe("28 сен");
    expect(dayOf(new Date(2025, 8, 28).toISOString(), now)).toBe("28 сен 2025");
    expect(dayOf(new Date(2026, 9, 5, 10, 42).toISOString(), now)).toMatch(/^сегодня, 10:42$/);
  });
});
