import { describe, expect, it } from "vitest";
import type { VideoSingleBox, VideoTrack } from "../../auth/api";
import {
  clampDock, clockText, coveredSpans, mergeSpans, presenceAt, scoutHeat, seekToTrack, singleTicks, timeTicks, trackNumbers,
} from "./video";

const g = { x: 0, y: 0, w: 10, h: 10 };
const track = (over: Partial<VideoTrack> = {}): VideoTrack => ({
  id: "t1", class_index: 0, start_frame: 10, end_frame: null, interpolate: true, export_step: 1,
  label: null, hidden_ranges: [], keys: [{ frame_no: 10, geometry: g }, { frame_no: 20, geometry: g }],
  ...over,
} as VideoTrack);
const single = (frame_no: number, class_index: number | null = 1): VideoSingleBox =>
  ({ id: `s${frame_no}`, frame_no, class_index, geometry: g, source: "human" });

describe("отрезки покрытия", () => {
  it("соседние и пересекающиеся склеиваются, далёкие — нет", () => {
    expect(mergeSpans([[5, 6], [0, 2], [3, 4], [10, 12]])).toEqual([[0, 6], [10, 12]]);
  });

  it("трек без заслонов и одиночный на своём кадре", () => {
    expect(coveredSpans([track()], [single(40)])).toEqual([[10, 20], [40, 40]]);
  });

  it("заслон разрывает трек, трек без класса не считается", () => {
    const t = track({ hidden_ranges: [[13, 16]] });
    expect(coveredSpans([t, track({ id: "t2", class_index: null })], [])).toEqual([[10, 13], [16, 20]]);
  });
});

describe("риски одиночных", () => {
  it("по кадрам, без повторов класса на одном кадре, без пустого класса", () => {
    expect(singleTicks([single(7), single(3), single(7), single(9, null)])).toEqual([
      { frame: 3, ci: 1 }, { frame: 7, ci: 1 },
    ]);
  });
});

describe("тепловая разведки", () => {
  it("самый частый участок — полная яркость, остальные тусклее, но видны", () => {
    const heat = scoutHeat([{ spans: [[0, 5, 4]] }, { spans: [[3, 9, 1]] }]);
    expect(heat).toEqual([[0, 5, 1], [3, 9, 0.44]]);
  });
});

describe("трек на кадре", () => {
  it("ключ, между ключами, заслонён и вне жизни", () => {
    const t = track({ hidden_ranges: [[15, 17]] });
    expect(presenceAt(t, 10)).toBe("key");
    expect(presenceAt(t, 12)).toBe("between");
    expect(presenceAt(t, 15)).toBe("hidden");
    expect(presenceAt(t, 30)).toBeNull();
  });

  it("номера по порядку заведения", () => {
    expect(trackNumbers([track(), track({ id: "t9" })]).get("t9")).toBe(2);
  });

  it("переход к треку — к ближайшему краю его жизни", () => {
    expect(seekToTrack(track(), 15)).toBe(15);
    expect(seekToTrack(track(), 3)).toBe(10);
    expect(seekToTrack(track(), 99)).toBe(20);
  });
});

describe("линейка", () => {
  it("круглые секунды не теснее порога", () => {
    // 60 с на 600 px: 5 с = 50 px мало, 10 с = 100 px
    expect(timeTicks(1500, 25, 600).map((x) => x.frame)).toEqual([0, 250, 500, 750, 1000, 1250, 1500]);
  });

  it("короткий ролик — доли секунды", () => {
    expect(timeTicks(29, 25, 900).slice(0, 3).map((x) => x.frame)).toEqual([0, 5, 10]);
  });

  it("дробная частота не портит подписи", () => {
    expect(timeTicks(1499, 24.97, 1400).map((x) => clockText(x.t)).slice(0, 3)).toEqual(["0:00", "0:05", "0:10"]);
  });

  it("подписи минутами и секундами", () => {
    expect(clockText(65)).toBe("1:05");
    expect(clockText(0.2)).toBe("0:00,2");
  });
});

describe("высота дока", () => {
  it("не меньше минимума и оставляет место кадру", () => {
    expect(clampDock(40, 900)).toBe(150);
    expect(clampDock(800, 900)).toBe(680);
    expect(clampDock(320, 900)).toBe(320);
  });
});
