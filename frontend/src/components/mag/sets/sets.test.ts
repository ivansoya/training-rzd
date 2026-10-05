import { describe, expect, it } from "vitest";
import type { Run } from "../../../api/runs";
import type { FeedRow, TrainSet } from "../../../api/trainsets";
import { bytes, flowsOf, graphsOf, multiplier, runsBySet, seedFromSet, similarName } from "./sets";

const run = (over: Partial<Run>): Run => ({
  id: "r", number: 1, name: "п", status: "done", queue_reason: null, task: "detect", base_model: "yolo11n", imgsz: 640,
  device: "0", epochs: 10, current_epoch: 10, phase: null, current_batch: 0, total_batches: null, val_batch: 0,
  val_total: null, batch_metrics: null, best_epoch: null, best_fitness: null, best_metrics: {}, spark: [],
  train_seconds: 0, resumable: false, peak_vram_mb: null, has_weights: true, weights_bytes: null, error: null,
  author: null, created_at: "2026-10-05T10:00:00", queued_at: null, started_at: null, finished_at: null,
  set: { id: "s1", name: "Набор", kind: "bbox", counts: null, graphs: [] }, ...over,
});

const g = { id: "g1", name: "Погода", version: 3, version_id: "v3" };
const feeds: FeedRow[] = [
  { part: "val", position: 0, graph_version_id: null, bindings: [{ source_node: "", feed: "val", tag_ids: [] }], graph: null },
  { part: "train", position: 0, graph_version_id: "v3", graph: g, bindings: [{ source_node: "src1", feed: "train", tag_ids: [] }] },
  { part: "train", position: 1, graph_version_id: "v3", graph: g, bindings: [{ source_node: "src1", feed: "tags", tag_ids: ["t1", "t2"] }] },
];

describe("наборы", () => {
  it("размер и множитель", () => {
    expect(bytes(0)).toBe("0 Б");
    expect(bytes(1536)).toBe("1,5 КБ");
    expect(bytes(2 * 1024 ** 3)).toBe("2 ГБ");
    const counts = { samples: 4784, source_images: 1840, train: 0, val: 0, annotations: 0, classes: 0, warnings: 0 };
    expect(multiplier({ counts })).toBe("×2,6");
    expect(multiplier({ counts: { ...counts, samples: 1840 } })).toBeNull();
    expect(multiplier({ counts: null })).toBeNull();
  });

  it("обучения по наборам: новые сверху, лучшее по mAP50", () => {
    const m = runsBySet([
      run({ id: "a", number: 3, best_metrics: { "metrics/mAP50(B)": 0.61 } }),
      run({ id: "b", number: 5, best_metrics: { "metrics/mAP50(B)": 0.71 } }),
      run({ id: "c", number: 7, status: "running" }),
      run({ id: "d", number: 8, set: null }),
      run({ id: "e", number: 2, set: { id: "s2", name: "Другой", kind: "bbox", counts: null, graphs: [] } }),
    ]);
    expect(m.get("s1")?.runs.map((r) => r.number)).toEqual([7, 5, 3]);
    expect(m.get("s1")?.best).toEqual({ number: 5, map50: 0.71 });
    expect(m.get("s2")?.best).toBeNull();
    expect(m.size).toBe(2);
  });

  it("схема сборки: train раньше val, числа по строке, таги словами", () => {
    const built = [
      { part: "train" as const, position: 0, source_node: "src1", source_name: "Источник", feed: "train" as const, images: 1472, samples: 4416 },
      { part: "val" as const, position: 0, source_node: null, source_name: null, feed: "val" as const, images: 368, samples: 368 },
    ];
    const f = flowsOf({ feeds }, built, (id) => ({ t1: "ночь", t2: "дождь" })[id] ?? id);
    expect(f.map((x) => [x.part, x.source, x.images, x.samples])).toEqual([
      ["train", "train целиком", 1472, 4416],
      ["train", "кадры с тагами «ночь», «дождь»", null, null],
      ["val", "val целиком", 368, 368],
    ]);
    expect(f[0].graph?.name).toBe("Погода");
    expect(f[2].graph).toBeNull();
    // Без отчёта сборки чисел нет, но строки есть
    expect(flowsOf({ feeds }, null, (id) => id).every((x) => x.samples === null)).toBe(true);
  });

  it("графы набора без повторов", () => {
    expect(graphsOf({ feeds })).toEqual([g]);
    expect(graphsOf({ feeds: [] })).toEqual([]);
  });

  it("имя похожего набора свободно", () => {
    expect(similarName("Ночь", ["Ночь"])).toBe("Ночь (2)");
    expect(similarName("Ночь (2)", ["Ночь", "Ночь (2)"])).toBe("Ночь (3)");
  });

  it("похожий набор: пропавшие датасеты и классы отпадают и считаются", () => {
    const set = {
      spec: { datasets: ["d1", "d2"], classes: ["c1", "c2", "c3"], dataset_parts: { d1: "train" as const, d2: "val" as const } },
      feeds, split_mode: "balanced" as const, val_ratio: 0.2, seed: 7, kind: "bbox" as const,
    } satisfies Partial<TrainSet>;
    const got = seedFromSet(set, { datasets: ["d1"], classes: ["c1", "c3"] });
    expect(got.spec.datasets).toEqual(["d1"]);
    expect(got.spec.classes).toEqual(["c1", "c3"]);
    expect(got.spec.dataset_parts).toEqual({ d1: "train" });
    expect(got.lost).toEqual({ datasets: 1, classes: 1 });
    expect(got.spec.feeds?.[1]).not.toHaveProperty("graph");
    expect(got.spec.seed).toBe(7);
  });
});
