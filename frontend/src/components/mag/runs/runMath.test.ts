import { describe, expect, it } from "vitest";
import type { EpochRow } from "../../../api/runs";
import { epochX, isFinalCheck, left, progress, stageText, trainedEpochs } from "./runMath";

const rows = (n: number, seconds = 60): EpochRow[] =>
  Array.from({ length: n }, (_, i) => ({ epoch: i + 1, metrics: {}, seconds }));

describe("экран обучения", () => {
  it("осталось — только у идущего", () => {
    const run = { status: "running", phase: "train", current_epoch: 3, epochs: 10 } as const;
    expect(left(run, rows(2))).toBe("7 мин");
    expect(left({ ...run, status: "stopped" }, rows(2))).toBeNull();
    expect(left({ ...run, status: "done" }, rows(2))).toBeNull();
    expect(left({ ...run, phase: "final", current_epoch: 10 }, rows(10))).toBeNull();
  });

  it("итоговая проверка: не «эпоха 3 из 2», полоса не шире края", () => {
    const old = { status: "running", phase: "val", current_epoch: 3, epochs: 2 } as const;
    expect(isFinalCheck(old)).toBe(true);
    expect(stageText(old)).toBe("итоговая проверка");
    expect(progress(old)).toBe(1);
    const now = { status: "running", phase: "final", current_epoch: 2, epochs: 2 } as const;
    expect(stageText(now)).toBe("итоговая проверка");
    const mid = { status: "running", phase: "val", current_epoch: 2, epochs: 2 } as const;
    expect(stageText(mid)).toBe("эпоха 2 из 2");
    expect(progress({ ...mid, current_epoch: 1 })).toBe(0.5);
    expect(isFinalCheck({ ...old, status: "done" })).toBe(false);
  });

  it("строка итоговой проверки не рисуется эпохой", () => {
    const got = trainedEpochs({ epochs: 2, summary: { epochs_done: 2 } }, rows(3));
    expect(got.map((r) => r.epoch)).toEqual([1, 2]);
    // Ранняя остановка: 30 из 100, строка 31 — итоговая.
    expect(trainedEpochs({ epochs: 100, summary: { epochs_done: 30 } }, rows(31))).toHaveLength(30);
    // Идущее обучение без итогов — все строки в пределах эпох.
    expect(trainedEpochs({ epochs: 5, summary: null }, rows(3))).toHaveLength(3);
  });

  it("эпоха стоит над своей подписью", () => {
    expect(epochX(0, 50, 44, 596)).toBe(44);
    expect(epochX(50, 50, 44, 596)).toBe(596);
    expect(epochX(25, 50, 44, 596)).toBe(320);
  });
});
