import { describe, it, expect } from "vitest";
import { extensionFrame, timelineFrame, timelineTicks, visibleSpans } from "./timelineMath";

describe("shared timeline coordinates", () => {
  it("maps both endpoints and midpoint without a native slider thumb offset", () => {
    expect(timelineFrame(100,100,900,100)).toBe(0);
    expect(timelineFrame(550,100,900,100)).toBe(50);
    expect(timelineFrame(1000,100,900,100)).toBe(100);
    expect(timelineFrame(-20,100,900,100)).toBe(0);
    expect(timelineFrame(1300,100,900,100)).toBe(100);
  });
  it("extends from the actual edge, ignoring the handle's visual offset", () => {
    expect(extensionFrame(12,0,600,60,"start")).toBe(12);
    expect(extensionFrame(12,-40,600,60,"start")).toBe(8);
    expect(extensionFrame(12,40,600,60,"end")).toBe(16);
    expect(extensionFrame(12,-1000,600,60,"start")).toBe(0);
    expect(extensionFrame(12,1000,600,60,"end")).toBe(60);
  });
  it("never reverses the extension or divides by zero on a one-frame clip", () => {
    expect(extensionFrame(12,40,600,60,"start")).toBe(12);
    expect(extensionFrame(12,-40,600,60,"end")).toBe(12);
    expect(timelineFrame(1,0,0,0)).toBe(0);
    expect(timelineTicks(0,500)).toEqual([0]);
  });
  it("keeps endpoint labels and reduces tick density for narrow timelines", () => {
    for(const width of [200,500,1400]) {
      const ticks=timelineTicks(299,width);
      expect(ticks[0]).toBe(0);expect(ticks.at(-1)).toBe(299);
      expect(new Set(ticks).size).toBe(ticks.length);
      expect(ticks.every(t=>Number.isInteger(t)&&t>=0&&t<=299)).toBe(true);
    }
    expect(timelineTicks(299,200).length).toBeLessThan(timelineTicks(299,1400).length);
  });
  it("breaks the life bar exactly where a zone hides the object", () => {
    expect(visibleSpans(0,29,[])).toEqual([[0,29]]);
    // Отрезок полуоткрыт: кадр 20 снова виден, с него полоса и продолжается.
    expect(visibleSpans(0,29,[[10,20]])).toEqual([[0,10],[20,29]]);
    expect(visibleSpans(0,29,[[0,10]])).toEqual([[10,29]]);
    expect(visibleSpans(0,29,[[10,30]])).toEqual([[0,10]]);
    expect(visibleSpans(0,29,[[0,30]])).toEqual([]);
  });
  it("merges touching and unordered zones instead of drawing stubs between them", () => {
    expect(visibleSpans(0,29,[[20,25],[5,10]])).toEqual([[0,5],[10,20],[25,29]]);
    expect(visibleSpans(0,29,[[5,10],[10,15]])).toEqual([[0,5],[15,29]]);
    expect(visibleSpans(0,29,[[5,20],[8,12]])).toEqual([[0,5],[20,29]]);
    expect(visibleSpans(7,7,[])).toEqual([[7,7]]);
  });
});
