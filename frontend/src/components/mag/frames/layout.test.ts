import { describe, expect, it } from "vitest";
import { frameState, gridLayout, visibleRows } from "./layout";
import { doneShare, projectsLine, runLine } from "../projects";
import type { ProjectSummary } from "../../../auth/api";

describe("gridLayout", () => {
  it("кладёт столько плиток, сколько влезает не уже минимума", () => {
    const g = gridLayout(1000, 170, 6);
    expect(g.cols).toBe(5);
    expect(g.tileW * 5 + 6 * 4).toBeCloseTo(1000);
    expect(g.rowH).toBeCloseTo(g.tileW * 3 / 4);
  });
  it("узкая сетка — одна колонка, а не ноль", () => {
    expect(gridLayout(80, 170).cols).toBe(1);
  });
});

describe("visibleRows", () => {
  it("сетка ниже окна — пусто", () => {
    const [a, b] = visibleRows(2000, 800, 100, 50, 0);
    expect(b - a).toBe(0);
  });
  it("прокрученная сетка отдаёт ряды окна с запасом", () => {
    expect(visibleRows(-1000, 800, 100, 50, 2)).toEqual([8, 20]);
  });
  it("не выходит за число рядов", () => {
    expect(visibleRows(0, 5000, 100, 10)).toEqual([0, 10]);
    expect(visibleRows(-100000, 800, 100, 10)).toEqual([10, 10]);
  });
});

describe("frameState", () => {
  it("кадр архива с рамками — размечен, хотя статус «new»", () => {
    expect(frameState("new", 3)).toBe("done");
  });
  it("осознанный фон без рамок — пусто, просто без рамок — без разметки", () => {
    expect(frameState("empty", 0)).toBe("empty");
    expect(frameState("new", 0)).toBe("new");
    expect(frameState(undefined, 0)).toBe("new");
  });
  it("отложенный остаётся отложенным", () => {
    expect(frameState("skipped", 2)).toBe("skip");
  });
});

const proj = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: "1", name: "П", code: "P", description: null, status: "ready", role: "admin", role_label: "Админ",
  members_count: 1, members: [], datasets_count: 1, images_count: 10, annotations_count: 0,
  classes_count: 1, tasks_open: 0, done_count: 0, last_run: null, created_at: "2026-10-01T00:00:00Z", ...over,
});

describe("подписи проектов", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  it("идущее обучение — с эпохой", () => {
    const r = runLine({ name: "yolo", status: "running", epoch: 3, epochs: 50, at: "2026-10-04T11:00:00Z" }, now);
    expect(r).toEqual({ text: "«yolo»: эпоха 3 из 50", tone: "live" });
  });
  it("без обучения и с готовым", () => {
    expect(runLine(null).tone).toBe("idle");
    expect(runLine({ name: "a", status: "done", epoch: 5, epochs: 5, at: "2026-10-04T11:59:30Z" }, now).text)
      .toBe("«a» готово только что");
  });
  it("строка списка считает приглашения и идущие обучения", () => {
    const live = proj({ last_run: { name: "x", status: "running", epoch: 1, epochs: 2, at: "" } });
    expect(projectsLine([live, proj({})], 1)).toBe("2 проекта · 1 приглашение · обучение идёт в 1 проекте");
  });
  it("доля пустого проекта — ноль", () => {
    expect(doneShare({ done_count: 0, images_count: 0 })).toBe(0);
    expect(doneShare({ done_count: 5, images_count: 10 })).toBe(.5);
  });
});
