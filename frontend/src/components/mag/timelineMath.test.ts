import { describe, it, expect } from "vitest";
import { extensionFrame, timelineFrame, timelineTicks } from "./timelineMath";

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
});
