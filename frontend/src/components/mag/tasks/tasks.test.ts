import { describe, expect, it } from "vitest";
import type { TaskCounts, TaskDetail, TaskLight, TaskStats, TaskVideoItem } from "../../../auth/api";
import {
  agentBadges, boardColumns, buildSources, busyText, cardLook, closePlan, closeText, cutCounts, dayOf, etaText, filterCutVideos, handoverText, leftText, percentOf, reelLine,
  reelStates, requestOrder, runPct, sourceLine, teamLine, waitingOf,
} from "./tasks";

const video = (id: string, mode: string, created = "2026-10-01T10:00:00Z") =>
  ({ id, mode, file_name: `${id}.mp4`, created_at: created, segments: [] }) as never;

const counts = (c: Partial<TaskCounts>): TaskCounts =>
  ({ total: 0, new: 0, skipped: 0, annotated: 0, empty: 0, deleted: 0, accepted: 0, ...c });

const card = (id: string, status: string, o: Partial<TaskLight> = {}) => ({
  id, name: id, status, assignees: [], status_at: "2026-10-01T00:00:00Z", last_at: "2026-10-01T00:00:00Z", ...o,
}) as TaskLight;
const stats = (c: Partial<TaskCounts>) => ({ counts: counts(c) }) as TaskStats;

describe("фильтры роликов на нарезку", () => {
  const videos = [
    { id: "camera-close", file_name: "CAMERA-close.mp4", frames: 5, tag_ids: ["a"] },
    { id: "camera-side", file_name: "camera-side.mp4", frames: 3, tag_ids: ["b"] },
    { id: "empty", file_name: "empty.mp4", frames: 0, tag_ids: [] },
  ] as TaskVideoItem[];
  const by = { "camera-close": { annotated: 5, reviewed: 4, agent: 1 }, "camera-side": { empty: 3, reviewed: 3 } };
  it("выбор по имени и любому тагу не меняет исходный список", () => {
    expect(filterCutVideos(videos, { q: " CAMERA ", tags: ["a", "b"], review: "all" }, by)).toHaveLength(2);
    expect(filterCutVideos(videos, { q: "side", tags: ["a"], review: "all" }, by)).toHaveLength(0);
    expect(videos).toHaveLength(3);
  });
  it("подтверждённость учитывает модель, фон считается размеченным", () => {
    expect(filterCutVideos(videos, { q: "", tags: [], review: "done" }, by).map((v) => v.id)).toEqual(["camera-side"]);
    expect(filterCutVideos(videos, { q: "", tags: [], review: "new" }, by).map((v) => v.id)).toEqual(["camera-close"]);
    expect(cutCounts(videos, by)).toMatchObject({ reviewed: 7, annotated: 5, empty: 3, agent: 1 });
  });
});

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
      .toEqual(["640 изображений", "3 ролика на нарезку (1 не нарезан)", "2 ролика на разметку"]);
    expect(sourceLine({ files: 0, cut: 0, uncut: 0, annotate: 0 })).toEqual(["пустая"]);
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
  // Куски строки — через «|»: на экране между ними черта
  const text = (line: (string | number)[][]) => line.map((p) => p.join("")).join(" | ");
  const badges = (l: ReturnType<typeof cardLook>) => l.badges.map((b) => b.text);

  it("изображения: брак сделан, отложенные — значком, кадры агента — в «осталось»", () => {
    const l = cardLook("in_progress", { counts: counts({ total: 40, annotated: 20, empty: 5, skipped: 3, new: 12, deleted: 2, agent: 4 }), sources: src({ files: 42 }) });
    expect(text(l.line)).toBe("сделано 27 | осталось 12");
    expect(text(l.short!)).toBe("27 / 42");
    expect(badges(l)).toEqual(["4 ждут проверки", "3 отложено"]);
    expect(l.parts.map((p) => p.value)).toEqual([20, 5, 2, 3, 12]);
  });

  it("ролик без агента — треки и рамки, с агентом — проверка по кадрам", () => {
    expect(text(cardLook("in_progress", { counts: counts({}), sources: src({ annotate: 1 }), videos: vids({ tracks: 7, boxes: 120 }) }).line))
      .toBe("7 треков | 120 рамок");
    const l = cardLook("in_progress", { counts: counts({}), sources: src({ annotate: 1 }), videos: vids({ tracks: 1, boxes: 3, agent_done: 340, agent_left: 1408 }) });
    expect(text(l.line)).toBe("проверено 340 | осталось 1408");
    expect(text(l.short!)).toBe("340 / 1748");
    expect(badges(l)).toEqual(["1 трек, 3 рамки"]);
  });

  it("смешанная таска: ролик значком после остального", () => {
    const l = cardLook("updating", { counts: counts({ total: 5, annotated: 5 }), sources: src({ files: 5, annotate: 2 }), videos: vids({ agent_done: 1, agent_left: 9 }), handover: "j1" });
    expect(badges(l)).toEqual(["сдаётся", "2 ролика: осталось проверить 9"]);
  });

  it("после проверки всех предложений ролика полоса проверки исчезает", () => {
    const l = cardLook("updating", { counts: counts({}), sources: src({ annotate: 1 }), videos: vids({ boxes: 12, agent_done: 8 }) });
    expect(l.parts).toEqual([]);
    expect(text(l.line)).not.toContain("осталось 0");
  });

  it("изменение и обзор показывают текущие кадры и изменения, а не пустую вкладку кадров", () => {
    const s = { counts: counts({}), sources: src({ annotate: 1 }), videos: vids({ boxes: 520, agent_done: 420 }),
      progress: { annotated: 420, changed: 12 } };
    const l = cardLook("updating", s);
    expect(text(l.line)).toBe("размечено 420 | изменено 12");
    expect(text(l.short ?? l.line)).toBe("размечено 420 | изменено 12");
    expect(l.parts).toEqual([]);
  });

  it("обзор не подменяет текущую разметку нулём проверенных предложений агента", () => {
    const l = cardLook("in_progress", { counts: counts({}), sources: src({ annotate: 1 }),
      videos: vids({ boxes: 520, agent_done: 0, agent_left: 1349 }), progress: { annotated: 420, changed: null } });
    expect(text(l.short ?? l.line)).toBe("размечено 420 | проверить 1349");
    expect(l.parts.map((p) => p.value)).toEqual([420, 1349]);
    const legacy = cardLook("updating", { counts: counts({}), sources: src({ annotate: 1 }),
      videos: vids(), progress: { annotated: 420, changed: null } });
    expect(text(legacy.line)).toBe("размечено 420 | изменено —");
  });

  it("сданная — все изображения вместе с кадрами роликов", () => {
    const c = counts({ total: 4, annotated: 4, accepted: 4, video_accepted: 422, video: { total: 426, new: 4, skipped: 0, annotated: 422, empty: 0, deleted: 0, agent: 4 } });
    const l = cardLook("done", { counts: c, sources: src({ annotate: 1 }) });
    expect(text(l.line)).toBe("430 изображений | 426 в датасете");
    expect(text(l.short!)).toBe("426 / 430");
    expect(badges(l)).toEqual(["4 ждут проверки"]);
    expect(text(cardLook("closed", { counts: counts({ total: 3, annotated: 3, accepted: 3 }), sources: src() }).line)).toBe("3 изображения в датасете");
  });
});

describe("ход агента (решения 29.10.2026)", () => {
  // Разведка «Искры» из макета: 30 роликов, план по шагу 25, скорость 1,8 кадра/с
  const plan = [1198, 1798, 1196, 1198, 1198, 1798];
  const run = (over: object) => ({ status: "running", mode: "scout", videos: ["a", "b", "c", "d", "e", "f"], processed: 0, total: 35834,
    rate: null, cpu: false, stats: { plan }, ...over }) as never;

  it("время — до минуты, часы с минутами", () => {
    expect(etaText(17223)).toBe("≈ 4 ч 47 мин");
    expect(etaText(310)).toBe("≈ 5 мин");
    expect(etaText(3600)).toBe("≈ 1 ч");
    expect(etaText(5)).toBe("≈ 1 мин");
  });

  it("плашка: процент вниз, без скорости — «считаю время», ждущему — ничего", () => {
    const going = run({ processed: 4832, rate: 1.8, stats: { plan, cursor: [3, -1] } });
    expect(runPct(going)).toBe(13);
    expect(runPct(run({ processed: 35833 }))).toBe(99);
    expect(leftText(going)).toBe("осталось ≈ 4 ч 47 мин");
    expect(leftText(run({ processed: 5 }))).toBe("считаю время");
    expect(leftText(run({ status: "waiting_gpu" }))).toBeNull();
    expect(reelLine(going)).toBe("ролик 4 из 6");
    expect(reelLine(run({ stats: { cursor: [6, -1] } }))).toBe("ролик 6 из 6");
    expect(reelLine(run({ mode: "frames", stats: { cursor: ["x.jpg", "id"] } }))).toBeNull();
  });

  it("ролики: пройденные, текущий из своего плана, очередь с местом и временем до начала", () => {
    // Пройдено три ролика (4192 кадра) и 640 кадров четвёртого
    const got = reelStates(run({ processed: 4832, rate: 1.8, stats: { plan, cursor: [3, -1] } }));
    expect(got.get("c")).toEqual({ kind: "done" });
    expect(got.get("d")).toEqual({ kind: "cur", done: 640, plan: 1198, secs: 558 / 1.8 });
    expect(got.get("e")).toEqual({ kind: "queue", place: 1, secs: 558 / 1.8 });
    expect(got.get("f")).toEqual({ kind: "queue", place: 2, secs: (558 + 1198) / 1.8 });
  });

  it("без скорости — места без времени; ждёт карту — текущего нет, первый в очереди", () => {
    const early = reelStates(run({ processed: 5 }));
    expect(early.get("a")).toEqual({ kind: "cur", done: 5, plan: 1198, secs: null });
    expect(early.get("b")).toEqual({ kind: "queue", place: 1, secs: null });
    const wait = reelStates(run({ status: "waiting_gpu" }));
    expect(wait.get("a")).toEqual({ kind: "queue", place: 1, secs: null });
    expect(wait.get("c")).toEqual({ kind: "queue", place: 3, secs: null });
    // Прогон без плана (начат до выкладки): ход ролика не известен, но где он — известно
    expect(reelStates(run({ stats: { cursor: [1, -1] } })).get("b")).toEqual({ kind: "cur", done: undefined, plan: undefined, secs: null });
    expect(reelStates(run({ mode: "frames" })).size).toBe(0);
  });

  it("параллельный ход различает готовый ролик, две текущие копии, ошибку и очередь", () => {
    const group = run({ stats: { completed_videos: ["a"] }, parallel: { count: 3, pending: 2, copies: [
      { videos: ["b"], current: "b.mp4", status: "running", item_processed: 20, item_total: 100, rate: 2 },
      { videos: ["c"], current: "c.mp4", status: "error", item_processed: 3, item_total: 50, rate: null },
      { videos: ["d"], current: "d.mp4", status: "waiting_gpu", item_processed: 0, item_total: 100, rate: null },
    ] } });
    const states = reelStates(group);
    expect(reelLine(group)).toBe("готово роликов 1 из 6");
    expect(states.get("a")).toEqual({ kind: "done" });
    expect(states.get("b")).toEqual({ kind: "cur", done: 20, plan: 100, secs: 40 });
    expect(states.get("c")?.kind).toBe("error");
    expect(states.get("d")).toEqual({ kind: "queue", done: 0, plan: 100, secs: null });
    expect(states.get("e")).toEqual({ kind: "queue", place: 1 });
    expect(states.get("f")).toEqual({ kind: "queue", place: 2 });
  });

  it("погашенные пункты и значок доски говорят, что идёт и сколько ждать", () => {
    const going = run({ processed: 4832, rate: 1.8 });
    expect(busyText(going)).toBe("идёт разведка, осталось ≈ 4 ч 47 мин");
    expect(busyText(run({ mode: "frames", processed: 3 }))).toBe("идёт разметка, считаю время");
    expect(busyText(run({ status: "waiting_gpu", cpu: true }))).toBe("агент ждёт процессор");
    expect(agentBadges(going).map((b) => b.text)).toEqual(["агент разведывает", ["13 %", "≈ 4 ч 47 мин"]]);
    expect(agentBadges(going)[0].live).toBe(true);
    expect(agentBadges(run({ status: "queued" })).map((b) => b.text)).toEqual(["агент в очереди"]);
  });
});
