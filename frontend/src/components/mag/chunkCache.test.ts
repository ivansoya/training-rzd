import { describe, expect, it, vi } from "vitest";
import { ChunkCache } from "./chunkCache";

/**
 * Поведение кэша перегонов описано разметчиком так: «резко идёт переход в
 * другое место — они выбрасываются в кэш, кэш переполняется, удаляются».
 * Здесь это и проверяется, потому что прежняя уборка вела себя иначе: она
 * судила по расстоянию от последнего загруженного, а не по давности.
 */

describe("кэш перегонов", () => {
  it("держит столько, сколько разрешили", () => {
    const cache = new ChunkCache<number>(3);
    for (let n = 0; n < 10; n += 1) cache.set(`720:${n}`, n);
    expect(cache.size).toBe(3);
  });

  it("выбрасывает самое давнее, а не самое дальнее", () => {
    const cache = new ChunkCache<number>(3);
    cache.set("720:0", 0);
    cache.set("720:1", 1);
    cache.set("720:2", 2);
    cache.set("720:3", 3);
    expect(cache.keys()).toEqual(["720:1", "720:2", "720:3"]);
  });

  it("чтение освежает: тронутое переживает соседей", () => {
    const cache = new ChunkCache<number>(3);
    cache.set("720:0", 0);
    cache.set("720:1", 1);
    cache.set("720:2", 2);
    // Вернулись к нулевому — теперь он самый свежий.
    expect(cache.get("720:0")).toBe(0);
    cache.set("720:3", 3);
    expect(cache.keys()).toEqual(["720:2", "720:0", "720:3"]);
  });

  it("подглядывание не освежает", () => {
    const cache = new ChunkCache<number>(2);
    cache.set("720:0", 0);
    cache.set("720:1", 1);
    expect(cache.peek("720:0")).toBe(0);
    cache.set("720:2", 2);
    // Ноль только подглядели — он и ушёл.
    expect(cache.keys()).toEqual(["720:1", "720:2"]);
  });

  it("после прыжка прежние перегоны доживают, пока есть место", () => {
    // Восемь мест, как в читателе: место у курсора — текущий, три вперёд,
    // один назад. После прыжка в другое место туда же помещается новая
    // пятёрка, и часть прежних ещё цела.
    const cache = new ChunkCache<number>(8);
    const around = (n: number) => {
      for (const i of [n - 1, n, n + 1, n + 2, n + 3]) cache.set(`720:${i}`, i);
    };
    around(10);
    around(100);
    expect(cache.size).toBe(8);
    // Вернуться к самому свежему из прежних — ещё можно, ходить в сеть не надо.
    expect(cache.has("720:13")).toBe(true);
    // А самое давнее уже ушло.
    expect(cache.has("720:9")).toBe(false);
  });

  it("говорит хозяину, что именно выбросил", () => {
    const gone = vi.fn();
    const cache = new ChunkCache<string>(2, gone);
    cache.set("a", "первый");
    cache.set("b", "второй");
    cache.set("c", "третий");
    expect(gone).toHaveBeenCalledWith("a", "первый");
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("повторная запись не плодит места и освежает", () => {
    const cache = new ChunkCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 11);
    cache.set("c", 3);
    expect(cache.keys()).toEqual(["a", "c"]);
    expect(cache.peek("a")).toBe(11);
  });
});
