import { describe, expect, it, vi } from "vitest";
import { Stalled, serialQueue, withDeadline } from "./decodeQueue";

/**
 * Свойство, ради которого всё это и вынесено: очередь разжатия не встаёт
 * навсегда.
 *
 * Стоила эта проверка дорого. Декодер браузера после ошибки умеет не
 * завершить `flush()` вовсе; очередь на одну дорожку в этот момент
 * останавливалась целиком, и редактор замирал — при живой сети, целых
 * перегонах и без единой ошибки в консоли. Снаружи это выглядело как
 * бесконечная загрузка после случайной перемотки, и найти причину по
 * симптому было нельзя: ничего не происходило вообще.
 */

/** Обещание, которое не завершится никогда, — то самое `flush()`. */
function forever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

describe("потолок ожидания", () => {
  it("отдаёт результат, когда работа успела", async () => {
    await expect(withDeadline(Promise.resolve(7), 50, "работа")).resolves.toBe(7);
  });

  it("пропускает настоящую ошибку как есть", async () => {
    const boom = new Error("настоящая беда");
    await expect(withDeadline(Promise.reject(boom), 50, "работа")).rejects.toBe(boom);
  });

  it("объявляет застрявшим то, что не завершилось", async () => {
    vi.useFakeTimers();
    try {
      const caught = withDeadline(forever<number>(), 3000, "Слив декодера").catch(
        (e) => e
      );
      await vi.advanceTimersByTimeAsync(3000);
      const err = await caught;
      expect(err).toBeInstanceOf(Stalled);
      expect(String(err)).toContain("Слив декодера");
    } finally {
      // Иначе упавшая проверка оставит поддельное время следующим — и они
      // повиснут на ровном месте, ища причину не там.
      vi.useRealTimers();
    }
  });

  it("снимает будильник, когда работа успела: он не выстрелит потом", async () => {
    const clear = vi.fn();
    const set = vi.fn(() => 42);
    await withDeadline(Promise.resolve("готово"), 1000, "работа", { set, clear });
    expect(clear).toHaveBeenCalledWith(42);
  });
});

describe("очередь на одну дорожку", () => {
  it("держит порядок", async () => {
    const run = serialQueue();
    const order: number[] = [];
    const step = (n: number, ms: number) =>
      run(async () => {
        await new Promise((r) => setTimeout(r, ms));
        order.push(n);
      });
    await Promise.all([step(1, 30), step(2, 10), step(3, 0)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("не рвётся на неудаче: следующая задача всё равно идёт", async () => {
    const run = serialQueue();
    const failed = run(async () => {
      throw new Error("не вышло");
    });
    await expect(failed).rejects.toThrow("не вышло");
    await expect(run(async () => "живём")).resolves.toBe("живём");
  });

  it("застрявшая задача не держит очередь, если у неё есть потолок", async () => {
    vi.useFakeTimers();
    const run = serialQueue();

    // Первая задача — тот самый молчащий декодер, но под потолком.
    try {
      const stuck = run(() =>
        withDeadline(forever<string>(), 3000, "Кадр 1")
      ).catch((e) => e);
      // Вторая встала за ней. Раньше она не дожидалась своей очереди никогда.
      const after = run(async () => "кадр 2");

      await vi.advanceTimersByTimeAsync(3000);
      expect(await stuck).toBeInstanceOf(Stalled);
      await expect(after).resolves.toBe("кадр 2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("без потолка очередь встаёт — это и была поломка", async () => {
    vi.useFakeTimers();
    const run = serialQueue();
    try {
      run(() => forever<string>());
      let done = false;
      void run(async () => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(done).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
