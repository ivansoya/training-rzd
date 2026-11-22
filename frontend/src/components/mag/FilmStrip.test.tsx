import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import FilmStrip, { visibleFilmRange } from "./FilmStrip";

vi.mock("../../auth/api", () => ({ imageThumbUrl: (id: string) => `/thumb/${id}` }));

describe("вертикальная лента кадров", () => {
  it("покрывает 36 687 кадров, но строит только видимые элементы", () => {
    const getItem = vi.fn((i: number) => ({ id: String(i), width: null, height: null }));
    const html = renderToStaticMarkup(<FilmStrip vertical total={36_687} getItem={getItem} index={0} onPick={() => {}} />);
    expect(html).toContain("height:2769860.5px");
    expect(getItem).toHaveBeenCalledTimes(16);
  });

  it("вычисляет позицию при прямом переходе далеко за первые окна", () => {
    const stride = 75.5;
    expect(visibleFilmRange(stride * 35_000 + 4, 800, stride)).toEqual({ start: 34_997, end: 35_014 });
    expect(visibleFilmRange(0, 800, stride)).toEqual({ start: 0, end: 14 });
  });
});
