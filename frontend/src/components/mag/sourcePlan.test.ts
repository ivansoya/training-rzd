import { describe, expect, it } from "vitest";
import { fromBase64, packetPositions, sliceSegment, warmOrder } from "./sourcePlan";
import type { ClipSegment } from "../../auth/api";

// Файл: заголовок 10 байт, потом кадры 3, 2, 4 байта, между вторым и третьим — 5 байт звука.
const sizes = [3, 2, 4];
const gaps = [10, 0, 5];
const file = new Uint8Array(24);
[[10, 11, 12], [13, 14], [20, 21, 22, 23]].forEach((frame, i) =>
  frame.forEach((at) => (file[at] = 100 + i))
);

describe("отрезки по Range", () => {
  it("смещение кадра — зазоры и размеры всех перед ним", () => {
    expect([...packetPositions(sizes, gaps)]).toEqual([10, 13, 20]);
  });

  it("кадры вырезаются ровно своими байтами, звук между ними пропускается", () => {
    const seg: ClipSegment = { n: 0, first: 0, count: 3, start: 10, end: 23 };
    const frames = sliceSegment(file.slice(10, 24).buffer, seg, packetPositions(sizes, gaps), sizes, new Set([0]));
    expect(frames.map((f) => [...f.data])).toEqual([[100, 100, 100], [101, 101], [102, 102, 102, 102]]);
    expect(frames.map((f) => [f.no, f.pres, f.key])).toEqual([[0, 0, true], [1, 1, false], [2, 2, false]]);
  });

  it("отрезок не с начала ролика несёт свои номера кадров", () => {
    const seg: ClipSegment = { n: 1, first: 2, count: 1, start: 20, end: 23 };
    const [frame] = sliceSegment(file.slice(20, 24).buffer, seg, packetPositions(sizes, gaps), sizes, new Set([2]));
    expect([frame.no, frame.pres, frame.key, [...frame.data]]).toEqual([2, 0, true, [102, 102, 102, 102]]);
  });

  it("недоехавший отрезок — отказ, а не кадры из чужих байтов", () => {
    const seg: ClipSegment = { n: 0, first: 0, count: 3, start: 10, end: 23 };
    expect(() =>
      sliceSegment(file.slice(10, 20).buffer, seg, packetPositions(sizes, gaps), sizes, new Set([0]))
    ).toThrow(/байт/);
  });

  it("таблица, разошедшаяся с отрезком, — отказ", () => {
    // Сервер объявил отрезок короче, чем лежат кадры по таблице.
    const seg: ClipSegment = { n: 0, first: 0, count: 3, start: 10, end: 21 };
    expect(() =>
      sliceSegment(file.slice(10, 22).buffer, seg, packetPositions(sizes, gaps), sizes, new Set([0]))
    ).toThrow(/не лежит/);
  });
});

describe("порядок прогрева", () => {
  it("текущий первым, потом вперёд, потом назад", () => {
    expect(warmOrder(5, 20, 3, 1)).toEqual([5, 6, 7, 8, 4]);
  });

  it("у краёв ролика лишних нет", () => {
    expect(warmOrder(0, 20, 3, 1)).toEqual([0, 1, 2, 3]);
    expect(warmOrder(19, 20, 3, 1)).toEqual([19, 18]);
  });
});

it("описание потока из base64 — те же байты", () => {
  expect([...fromBase64("AWQAH/8=")]).toEqual([1, 100, 0, 31, 255]);
});
