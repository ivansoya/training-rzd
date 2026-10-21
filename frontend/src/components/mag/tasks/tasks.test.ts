import { describe, expect, it } from "vitest";
import type { TaskCounts, TaskDetail, TaskLight, TaskStats } from "../../../auth/api";
import {
  agentVideo, boardColumns, buildSources, cardLook, closePlan, closeText, dayOf, handoverText, percentOf, requestOrder, sourceLine, teamLine, waitingOf,
} from "./tasks";

const video = (id: string, mode: string, created = "2026-10-01T10:00:00Z") =>
  ({ id, mode, file_name: `${id}.mp4`, created_at: created, segments: [] }) as never;

const counts = (c: Partial<TaskCounts>): TaskCounts =>
  ({ total: 0, new: 0, skipped: 0, annotated: 0, empty: 0, deleted: 0, accepted: 0, ...c });

const card = (id: string, status: string, o: Partial<TaskLight> = {}) => ({
  id, name: id, status, assignees: [], status_at: "2026-10-01T00:00:00Z", last_at: "2026-10-01T00:00:00Z", ...o,
}) as TaskLight;
const stats = (c: Partial<TaskCounts>) => ({ counts: counts(c) }) as TaskStats;

describe("источники таски", () => {
  it("кадров размечаемого ролика блоком нет — в таске они правятся только в ролике", () => {
    const task = {
      videos: [video("v1", "annotate")],
      sources: { v1: { total: 16, frames: 16, first_at: null }, files: { total: 2, frames: 2, first_at: null } },
    } as unknown as TaskDetail;
    expect(buildSources(task, { v1: { new: 16 }, files: { new: 2 } }).map((b) => b.key)).toEqual(["files"]);
  });

  it("блоки встают по лёгкой части, числа — когда придут", () => {
    const task = {
      videos: [],
      sources: { files: { total: 2, frames: 0, first_at: "2026-09-01T00:00:00Z" } },
    } as unknown as TaskDetail;
    // Блок из одного брака остаётся; число кадров — без брака и сразу
    expect(buildSources(task, null).map((b) => [b.key, b.known, b.total])).toEqual([["files", false, 0]]);
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

  it("копии кадров датасета — свой блок с раскладкой по датасетам", () => {
    const task = {
      videos: [],
      sources: {
        files: { total: 1, frames: 1, first_at: "2026-10-02T00:00:00Z" },
        dataset: { total: 7, frames: 6, first_at: "2026-10-01T00:00:00Z", datasets: [{ id: "d1", name: "Инициализация", n: 6 }] },
      },
    } as unknown as TaskDetail;
    const [copies, files] = buildSources(task, { dataset: { annotated: 3, deleted: 1 }, files: { new: 1 } });
    expect(copies).toMatchObject({ key: "dataset", kind: "dataset", total: 6, datasets: [{ name: "Инициализация", n: 6 }] });
    expect(files.key).toBe("files");
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

  it("решённые копии датасета ложатся на исходники — в «уйдёт в датасет» их нет", () => {
    const p = closePlan(counts({ total: 7, annotated: 4, empty: 1, new: 2, copies_decided: 3 }), 0);
    expect(p.accept).toBe(2);
  });
});

describe("итог сдачи", () => {
  it("что ушло, что обновилось, что оставлено и что ждёт — одной строкой", () => {
    expect(handoverText({ accepted: 12, dataset: "Ш-12", created: 10, updated: 30, removed: 2, kept_edited: 1, waiting: 1, unchecked: 2 }))
      .toBe("В датасет «Ш-12» ушло 12 кадров. Кадры роликов в датасете: обновлено 30, убрано 2. "
        + "1 кадр правили в датасете — оставлен как есть. 3 кадра ждут проверки агента — в датасет не ушли.");
    // Повторная сдача без новых кадров — не «принимать нечего»: обновления тоже итог
    expect(handoverText({ accepted: 0, updated: 3 })).toBe("Кадры роликов в датасете: обновлено 3.");
    expect(handoverText({ accepted: 0 })).toBe("Размеченных кадров пока нет — принимать нечего.");
    expect(handoverText({ accepted: 2, removed_images: 5, removed_videos: 1 }))
      .toBe("В датасет ушло 2 кадра. Удалено 5 черновых кадров.");
    expect(handoverText({ accepted: 0, copies: { placed: 4, removed: 1, edited: 2, waiting: 1 } }))
      .toBe("Копии из датасета: на место 4, убрано из датасета 1. 2 исходника правили в датасете — оставлены как есть. "
        + "1 копия ждёт проверки агента.");
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

describe("карточка таски (решения 14.10.2026)", () => {
  const src = (o: Partial<TaskStats["sources"]> = {}) => ({ files: 0, cut: 0, uncut: 0, annotate: 0, ...o });
  const vids = (o: Partial<TaskStats["videos"]> = {}) => ({ tracks: 0, boxes: 0, agent_done: 0, agent_left: 0, ...o });
  const text = (line: (string | number)[]) => line.join("");
  const badges = (l: ReturnType<typeof cardLook>) => l.badges.map((b) => b.text);

  it("изображения: брак сделан, отложенные — значком, кадры агента — в «осталось»", () => {
    const l = cardLook("in_progress", { counts: counts({ total: 40, annotated: 20, empty: 5, skipped: 3, new: 12, deleted: 2, agent: 4 }), sources: src({ files: 42 }) });
    expect(text(l.line)).toBe("сделано 27 · осталось 12");
    expect(badges(l)).toEqual(["4 ждут проверки", "3 отложено"]);
    expect(l.parts.map((p) => p.value)).toEqual([20, 5, 2, 3, 12]);
  });

  it("ролик без агента — треки и рамки, с агентом — проверка по кадрам", () => {
    expect(text(cardLook("in_progress", { counts: counts({}), sources: src({ annotate: 1 }), videos: vids({ tracks: 7, boxes: 120 }) }).line))
      .toBe("7 треков · 120 рамок");
    const l = cardLook("in_progress", { counts: counts({}), sources: src({ annotate: 1 }), videos: vids({ tracks: 1, boxes: 3, agent_done: 340, agent_left: 1408 }) });
    expect(text(l.line)).toBe("проверено 340 · осталось 1408");
    expect(badges(l)).toEqual(["1 трек, 3 рамки"]);
  });

  it("смешанная таска: ролик значком после остального", () => {
    const l = cardLook("updating", { counts: counts({ total: 5, annotated: 5 }), sources: src({ files: 5, annotate: 2 }), videos: vids({ agent_done: 1, agent_left: 9 }), handover: "j1" });
    expect(badges(l)).toEqual(["сдаётся", "2 ролика: осталось проверить 9"]);
  });

  it("сданная — все изображения вместе с кадрами роликов", () => {
    const c = counts({ total: 4, annotated: 4, accepted: 4, video_accepted: 422, video: { total: 426, new: 4, skipped: 0, annotated: 422, empty: 0, deleted: 0, agent: 4 } });
    const l = cardLook("done", { counts: c, sources: src({ annotate: 1 }) });
    expect(text(l.line)).toBe("430 изображений · 426 в датасете");
    expect(badges(l)).toEqual(["4 ждут проверки"]);
    expect(text(cardLook("closed", { counts: counts({ total: 3, annotated: 3, accepted: 3 }), sources: src() }).line)).toBe("3 изображения в датасете");
  });
});

describe("agentVideo", () => {
  const run = (over: object) => ({ status: "running", mode: "annotate", videos: ["a", "b"], stats: {}, ...over }) as never;
  it("ролик под курсором; до первого кадра — первый; после последнего — никакой", () => {
    expect(agentVideo(run({}))).toBe("a");
    expect(agentVideo(run({ stats: { cursor: [1, 250] } }))).toBe("b");
    expect(agentVideo(run({ stats: { cursor: [2, -1] } }))).toBeUndefined();
  });
  it("только идущий прогон роликов", () => {
    expect(agentVideo(run({ status: "waiting_gpu" }))).toBeUndefined();
    expect(agentVideo(run({ mode: "frames", stats: { cursor: ["x.jpg", "id"] } }))).toBeUndefined();
    expect(agentVideo(run({ mode: "scout", stats: { cursor: [1, -1] } }))).toBe("b");
  });
});
