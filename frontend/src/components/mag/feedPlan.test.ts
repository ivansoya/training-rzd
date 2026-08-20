import { describe, expect, it } from "vitest";
import { feedPlan } from "./feedPlan";
import type { PlanChunk } from "./feedPlan";

/**
 * Стык перегонов. Ролик разложен по файлам, но для разметчика он один, и
 * декодер обязан идти сквозь границы, не начиная заново.
 *
 * Проверяется здесь не «плавно ли», а точность: какие именно кадры скормлены.
 * Пропустить кадр на стыке — это не дёрнувшаяся картинка, а бокс, вставший на
 * соседний кадр и молча уехавший в датасет.
 */

const ALL = () => true;
const NONE = () => false;

function ролик(count: number, size = 120): PlanChunk[] {
  return Array.from({ length: count }, (_, n) => ({
    n,
    first: n * size,
    count: size,
  }));
}

/** Все кадры, которые план скормит, — списком номеров ролика. */
function кадры(chunks: PlanChunk[], plan: ReturnType<typeof feedPlan>): number[] {
  const out: number[] = [];
  for (const s of plan.spans) {
    const c = chunks[s.chunk];
    for (let i = s.from; i <= s.to; i += 1) out.push(c.first + i);
  }
  return out;
}

describe("план кормления", () => {
  it("не выходит за перегон, если запас укладывается в него", () => {
    const chunks = ролик(3);
    const plan = feedPlan(chunks, 0, 0, 10, ALL);
    expect(plan.spans).toEqual([{ chunk: 0, from: 0, to: 10 }]);
    expect(plan.chunk).toBe(0);
    expect(plan.fed).toBe(11);
    expect(plan.wantNext).toBeNull();
  });

  it("переходит в следующий перегон и не теряет кадр на стыке", () => {
    const chunks = ролик(3);
    // Стоим на 115-м, запас вперёд — до 125-го, то есть за границу.
    const plan = feedPlan(chunks, 0, 115, 125, ALL);
    expect(кадры(chunks, plan)).toEqual([
      115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125,
    ]);
    expect(plan.chunk).toBe(1);
    expect(plan.fed).toBe(6);
  });

  it("переходит через несколько перегонов подряд", () => {
    const chunks = ролик(4);
    const plan = feedPlan(chunks, 0, 119, 245, ALL);
    expect(plan.spans.map((s) => s.chunk)).toEqual([0, 1, 2]);
    const list = кадры(chunks, plan);
    expect(list[0]).toBe(119);
    expect(list[list.length - 1]).toBe(245);
    // Ни одного пропуска и ни одного повтора.
    expect(list).toEqual(Array.from({ length: 245 - 119 + 1 }, (_, i) => 119 + i));
  });

  it("останавливается на неприехавшем и просит его", () => {
    const chunks = ролик(3);
    const plan = feedPlan(chunks, 0, 115, 125, NONE);
    expect(кадры(chunks, plan)).toEqual([115, 116, 117, 118, 119]);
    expect(plan.wantNext).toBe(1);
    expect(plan.chunk).toBe(0);
    expect(plan.fed).toBe(120);
  });

  it("на последнем перегоне переходить некуда", () => {
    const chunks = ролик(2);
    const plan = feedPlan(chunks, 1, 100, 400, ALL);
    expect(кадры(chunks, plan)).toEqual(
      Array.from({ length: 20 }, (_, i) => 220 + i)
    );
    expect(plan.wantNext).toBeNull();
    expect(plan.fed).toBe(120);
  });

  it("неполный последний перегон не выдумывает кадров", () => {
    const chunks: PlanChunk[] = [
      { n: 0, first: 0, count: 120 },
      { n: 1, first: 120, count: 30 },
    ];
    const plan = feedPlan(chunks, 0, 115, 200, ALL);
    expect(кадры(chunks, plan)).toEqual(
      Array.from({ length: 149 - 115 + 1 }, (_, i) => 115 + i)
    );
    expect(plan.chunk).toBe(1);
    expect(plan.fed).toBe(30);
  });

  it("когда всё нужное уже скормлено, кормить нечем", () => {
    const chunks = ролик(3);
    const plan = feedPlan(chunks, 0, 30, 20, ALL);
    expect(plan.spans).toEqual([]);
    expect(plan.fed).toBe(30);
  });

  it("продолжение с середины перегона не начинает его заново", () => {
    const chunks = ролик(3);
    const plan = feedPlan(chunks, 1, 40, 175, ALL);
    expect(plan.spans).toEqual([{ chunk: 1, from: 40, to: 55 }]);
    expect(кадры(chunks, plan)[0]).toBe(160);
  });
});
