import { describe, expect, it } from "vitest";
import type { Run } from "../../../api/runs";
import {
  confusionView, curveLabel, dayLabel, delta, duration, etaText, filterRuns, groupByDay, paramGroups, topConfusions,
  yoloAugChips,
} from "./runs";

const run = (over: Partial<Run>): Run => ({
  id: "r", number: 1, name: "п", status: "done", queue_reason: null, task: "detect", base_model: "yolo11n", imgsz: 640,
  device: "0", epochs: 10, current_epoch: 10, phase: null, current_batch: 0, total_batches: null, val_batch: 0,
  val_total: null, batch_metrics: null, best_epoch: null, best_fitness: null, best_metrics: {}, spark: [],
  train_seconds: 0, resumable: false, peak_vram_mb: null, has_weights: true, weights_bytes: null, error: null,
  author: null, created_at: "2026-10-05T10:00:00", queued_at: null, started_at: null, finished_at: null,
  set: { id: "s1", name: "Набор", kind: "bbox", counts: null, graphs: [] }, ...over,
});

describe("история", () => {
  it("фильтр: готовые, прерванные, набор и модель", () => {
    const rs = [run({ id: "a", status: "done" }), run({ id: "b", status: "stopped" }), run({ id: "c", status: "error", base_model: "yolo11s" }),
      run({ id: "d", status: "running", set: null })];
    expect(filterRuns(rs, { status: "done", set: "all", model: "all" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterRuns(rs, { status: "broken", set: "all", model: "all" }).map((r) => r.id)).toEqual(["b", "c"]);
    expect(filterRuns(rs, { status: "all", set: "s1", model: "all" }).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(filterRuns(rs, { status: "all", set: "all", model: "yolo11s" }).map((r) => r.id)).toEqual(["c"]);
  });

  it("дни: сегодня, вчера, дата; подряд идущие — одна группа", () => {
    const now = new Date(2026, 9, 5, 12);
    expect(dayLabel(new Date(2026, 9, 5, 1).toISOString(), now)).toBe("Сегодня");
    expect(dayLabel(new Date(2026, 9, 4, 23).toISOString(), now)).toBe("Вчера");
    expect(dayLabel(new Date(2026, 8, 28, 9).toISOString(), now)).toBe("28 сентября");
    expect(dayLabel(new Date(2025, 8, 28, 9).toISOString(), now)).toMatch(/2025/);
    const g = groupByDay([run({ id: "a", created_at: new Date(2026, 9, 5, 9).toISOString() }),
      run({ id: "b", created_at: new Date(2026, 9, 5, 8).toISOString() }),
      run({ id: "c", created_at: new Date(2026, 9, 3, 8).toISOString() })], now);
    expect(g.map((x) => [x.label, x.runs.length])).toEqual([["Сегодня", 2], ["3 октября", 1]]);
  });

  it("длительность и остаток", () => {
    expect(duration(0)).toBe("—");
    expect(duration(38)).toBe("38 с");
    expect(duration(42 * 60)).toBe("42 мин");
    expect(duration(65 * 60)).toBe("1 ч 05 мин");
    expect(etaText({ status: "running", phase: "train", current_epoch: 5, epochs: 10, train_seconds: 4 * 60 })).toBe("осталось ~6 мин");
    expect(etaText({ status: "running", phase: "train", current_epoch: 1, epochs: 10, train_seconds: 0 })).toBeNull();
    expect(etaText({ status: "running", phase: "final", current_epoch: 11, epochs: 10, train_seconds: 600 })).toBeNull();
  });
});

describe("страница прогона", () => {
  it("разница с прошлым", () => {
    expect(delta(0.812, 0.8)).toEqual({ text: "+0,012", dir: "up" });
    expect(delta(0.7, 0.75)).toEqual({ text: "−0,050", dir: "down" });
    expect(delta(0.5, 0.5002)?.dir).toBe("same");
    expect(delta(0.5, undefined)).toBeNull();
  });

  it("матрица: строка — истина, доли строки, пустые классы скрыты", () => {
    // ultralytics: строка — предсказание, столбец — истина; последний — фон
    const v = confusionView({
      names: ["a", "b", "пусто", "фон"],
      matrix: [
        [8, 1, 0, 2],
        [2, 9, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    });
    expect(v.names).toEqual(["a", "b", "фон"]);
    expect(v.hidden).toBe(1);
    expect(v.counts[0]).toEqual([8, 2, 0]); // a: верно 8, принят за b 2
    expect(v.shares[0][0]).toBeCloseTo(0.8);
    expect(v.counts[2]).toEqual([2, 0, 0]); // ложное «a» на фоне
    const top = topConfusions(v, 5);
    expect(top[0]).toMatchObject({ truth: 2, pred: 0, share: 1 });
    expect(top.some((t) => t.truth === 2 && t.pred === 2)).toBe(false);
  });

  it("параметры группами; аугментации YOLO — только в режиме yolo", () => {
    const r = run({ params: { epochs: 50, batch: 16, imgsz: 960, augment_mode: "yolo", mosaic: 1, fliplr: 0.5, hsv_h: 0 },
      peak_vram_mb: 9830, train_seconds: 3600 });
    const g = paramGroups(r, 9);
    expect(g.map((x) => x.title)).toEqual(["Модель", "Обучение", "Данные", "Аугментации YOLO", "Железо"]);
    expect(g[0].rows).toContainEqual(["Классов", "9"]);
    expect(g[4].rows).toContainEqual(["Пик видеопамяти", "9,6 ГБ"]);
    expect(paramGroups(run({ params: { augment_mode: "graph", mosaic: 1 } }), null).some((x) => x.title === "Аугментации YOLO")).toBe(false);
    expect(yoloAugChips(r.params)).toEqual(["Мозаика", "Отражение"]);
    expect(yoloAugChips({ augment_mode: "off", mosaic: 1 })).toEqual([]);
  });

  it("подписи кривых по порогу", () => {
    const c = (x: string, y: string, group?: "B" | "M") => ({ x_label: x, y_label: y, group });
    expect(curveLabel(c("Recall", "Precision"), 0, 4)).toBe("PR");
    expect(curveLabel(c("Confidence", "F1"), 1, 4)).toBe("F1");
    expect(curveLabel(c("Confidence", "Recall", "M"), 7, 8)).toBe("Полнота, маски");
  });
});
