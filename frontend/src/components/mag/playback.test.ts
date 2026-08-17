import { describe, expect, it } from "vitest";
import { frameAt, tickClock } from "./playback";

/** Ход времени при проигрывании — без браузера, без декодера и без ролика.
 *
 * Здесь решается, какой кадр разметчик видит в каждый момент. Ошибка тут не
 * ломает ничего заметного сразу: просто «на глаз» ролик идёт не с той
 * скоростью, а на быстрой перемотке место в ролике перестаёт совпадать с
 * ожиданием. Поэтому считаем это отдельно и проверяем числами.
 */
describe("кадр по прошедшему времени", () => {
  const fps = 25;
  const last = 1000;

  it("на обычной скорости идёт кадр в кадр", () => {
    expect(frameAt(0, 0, fps, 1, last)).toBe(0);
    expect(frameAt(0, 40, fps, 1, last)).toBe(1);
    expect(frameAt(0, 1000, fps, 1, last)).toBe(25);
  });

  it("считает от кадра, с которого начали", () => {
    expect(frameAt(300, 1000, fps, 1, last)).toBe(325);
  });

  it("замедление показывает все кадры, просто реже", () => {
    // Половинная скорость: за секунду проходит половина кадров, и ни один
    // не перепрыгнут — соседние номера идут подряд.
    expect(frameAt(0, 1000, fps, 0.5, last)).toBe(12);
    expect(frameAt(0, 2000, fps, 0.5, last)).toBe(25);
    expect(frameAt(0, 80, fps, 0.5, last)).toBe(1);
  });

  it("ускорение прореживает осознанно, а не «как повезёт»", () => {
    // 2× — это каждый второй кадр с обычной частотой: за секунду проходит
    // пятьдесят кадров ролика, но показов по-прежнему двадцать пять.
    expect(frameAt(0, 1000, fps, 2, last)).toBe(50);
    // Номера чётные — нечётные не показываются вовсе, и это осознанно:
    // ровная картинка вместо рванины на машине, которая не поспевает.
    expect(frameAt(0, 40, fps, 2, last)).toBe(2);
    expect(frameAt(0, 80, fps, 2, last)).toBe(4);
  });

  it("не уезжает за последний кадр", () => {
    expect(frameAt(990, 10_000, fps, 2, last)).toBe(last);
    expect(frameAt(0, 10_000_000, fps, 1, last)).toBe(last);
  });

  it("дробную частоту не округляет до целой", () => {
    // 25.033 к/с — такой ролик уже лежит в базе. За минуту разница с целой
    // частотой набегает в два кадра, и «тот самый кадр» перестаёт совпадать.
    expect(frameAt(0, 60_000, 25.033, 1, 10_000)).toBe(1501);
    expect(frameAt(0, 60_000, 25, 1, 10_000)).toBe(1500);
  });
});

describe("часы проигрывания ждут картинку", () => {
  const fps = 25;
  const last = 1000;

  it("пока картинка догоняет, время стоит", () => {
    let clock = { at: 0, frame: 100, last: 0 };
    // Полсекунды ждём разжатия: тикаем каждые 16 мс, картинки нет.
    for (let now = 16; now <= 500; now += 16) {
      clock = tickClock(clock, now, false);
      expect(frameAt(clock.frame, now - clock.at, fps, 1, last)).toBe(100);
    }
    // Ни один кадр не пропущен: стоим ровно на том, что показан.
    expect(frameAt(clock.frame, 500 - clock.at, fps, 1, last)).toBe(100);
  });

  it("после ожидания время идёт дальше, а не наверстывает пропущенное", () => {
    let clock = { at: 0, frame: 100, last: 0 };
    for (let now = 16; now <= 500; now += 16) clock = tickClock(clock, now, false);
    // Картинка догнала — дальше обычный ход.
    for (let now = 516; now <= 1500; now += 16) clock = tickClock(clock, now, true);
    // От старта прошло 1.5 с, но полсекунды мы стояли: ролик прошёл секунду.
    const at = frameAt(clock.frame, 1500 - clock.at, fps, 1, last);
    expect(at).toBe(125);
  });

  it("без ожидания ведёт себя как обычные часы", () => {
    let clock = { at: 0, frame: 0, last: 0 };
    for (let now = 16; now <= 1000; now += 16) clock = tickClock(clock, now, true);
    expect(clock.at).toBe(0);
    expect(frameAt(clock.frame, 1000 - clock.at, fps, 1, last)).toBe(25);
  });
});
