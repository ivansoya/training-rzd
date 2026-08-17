import { describe, expect, it } from "vitest";
import type { VideoTrack } from "../../auth/api";
import {
  boxAt,
  exportCount,
  fmtFrameTime,
  frameToMs,
  hiddenRanges,
  isHidden,
  keyAt,
  msToFrame,
  normalizeRanges,
  stateAt,
  trackEnd,
} from "./trackMath";

/** Редактор считает положение объекта сам, чтобы не ходить на сервер на каждый
 *  кадр. Значит, его расчёт обязан совпадать с серверным — иначе разметчик
 *  видит одно, а в датасет уезжает другое. Числа здесь те же, что в
 *  tests/unit/test_track_math.py. */

function key(frame_no: number, x: number, y = 0) {
  return { frame_no, geometry: { x, y, w: 10, h: 10 }, source: "human" };
}

function track(over: Partial<VideoTrack> = {}): VideoTrack {
  return {
    id: "t1",
    class_index: 0,
    start_frame: 100,
    end_frame: 160,
    interpolate: true,
    export_step: 5,
    label: null,
    hidden_ranges: [],
    keys: [key(100, 0), key(160, 60, 30)],
    ...over,
  };
}

describe("положение объекта на кадре", () => {
  it("на ключевом кадре отдаёт заданное руками", () => {
    expect(boxAt(track(), 100)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it("между ключами считает линейно", () => {
    expect(boxAt(track(), 130)).toEqual({ x: 30, y: 15, w: 10, h: 10 });
  });

  it("до появления объекта нет", () => {
    expect(boxAt(track(), 99)).toBeNull();
  });

  it("после исчезновения объекта нет", () => {
    expect(boxAt(track(), 161)).toBeNull();
  });

  it("без интерполяции держит предыдущий ключ", () => {
    expect(boxAt(track({ interpolate: false }), 130)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it("на заслонённом участке объекта нет", () => {
    const t = track({ hidden_ranges: [[120, 140]] });
    expect(boxAt(t, 130)).toBeNull();
    expect(boxAt(t, 119)).not.toBeNull();
    expect(boxAt(t, 140)).not.toBeNull();
  });

  it("заслонённый объект всё равно где-то находится", () => {
    // Редактор рисует его прерывистой рамкой — значит место знать надо.
    const state = stateAt(track({ hidden_ranges: [[120, 140]] }), 130);
    expect(state?.hidden).toBe(true);
    expect(state?.geometry).toEqual({ x: 30, y: 15, w: 10, h: 10 });
  });

  it("у трека без ключей ничего нет", () => {
    expect(boxAt(track({ keys: [] }), 100)).toBeNull();
  });

  it("округляет до сотых, как сервер", () => {
    const t = track({ start_frame: 0, end_frame: 3, keys: [key(0, 0), key(3, 1)] });
    expect(boxAt(t, 1)!.x).toBe(0.33);
  });
});

describe("жизнь трека", () => {
  it("без заданного конца тянется до последнего ключа", () => {
    expect(trackEnd(track({ end_frame: null }))).toBe(160);
  });

  it("находит ключ на кадре", () => {
    expect(keyAt(track(), 100)?.frame_no).toBe(100);
    expect(keyAt(track(), 101)).toBeNull();
  });

  it("отрезок полуоткрыт", () => {
    const t = track({ hidden_ranges: [[10, 20]] });
    expect(isHidden(t, 10)).toBe(true);
    expect(isHidden(t, 19)).toBe(true);
    expect(isHidden(t, 20)).toBe(false);
  });

  it("отрезки подрезаются жизнью трека", () => {
    const t = track({ hidden_ranges: [[50, 300]] });
    expect(hiddenRanges(t)).toEqual([[100, 161]]);
  });

  it("пересекающиеся отрезки склеиваются", () => {
    expect(normalizeRanges([[30, 40], [10, 20], [15, 25]])).toEqual([[10, 25], [30, 40]]);
  });

  it("пустые отрезки отбрасываются", () => {
    expect(normalizeRanges([[10, 10], [20, 15]])).toEqual([]);
  });
});

describe("сколько кадров уйдёт в проект", () => {
  it("считает по шагу", () => {
    expect(exportCount(track())).toBe(13); // 100..160 через 5
  });

  it("ключевые кадры вне шага тоже считаются", () => {
    expect(exportCount(track({ keys: [key(100, 0), key(137, 37), key(160, 60)] }))).toBe(14);
  });

  it("заслонённые кадры не считаются", () => {
    const t = track({ hidden_ranges: [[120, 140]] });
    // 100,105,110,115 + 140,145,150,155,160 — участок 120..139 выпал.
    expect(exportCount(t)).toBe(9);
  });
});

describe("кадры и время", () => {
  it("переводит номер кадра в миллисекунды", () => {
    expect(frameToMs(25, 25)).toBe(1000);
    expect(frameToMs(30, 30)).toBe(1000);
  });

  it("без частоты время не выдумывает", () => {
    expect(frameToMs(100, null)).toBe(0);
    expect(msToFrame(1000, 0)).toBe(0);
  });

  it("показывает время кадра с миллисекундами", () => {
    expect(fmtFrameTime(41500)).toBe("00:41.500");
    expect(fmtFrameTime(0)).toBe("00:00.000");
    expect(fmtFrameTime(3661500)).toBe("1:01:01.500");
  });
});
