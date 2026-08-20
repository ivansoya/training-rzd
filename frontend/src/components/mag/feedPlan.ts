/** Чем кормить декодер и где переходить в следующий перегон.
 *
 * Перегон — это отдельный файл, но для декодера он не должен быть отдельным
 * видео. Каждый начинается с опорного кадра, а описание потока у соседей одной
 * ступени одно и то же, — значит следующий перегон можно досыпать в тот же
 * декодер, ничего не перенастраивая и не сливая. Пока кормление упиралось в
 * конец своего перегона, на стыке всё начиналось заново, и ролик заметно
 * перезагружался ровно в тот момент, когда идёт.
 *
 * Здесь только арифметика: какие куски каких перегонов скормить. Ошибка на
 * единицу тут стоит дорого — пропущенный кадр это не «дёрнулась картинка», а
 * бокс, поставленный на соседний кадр и молча уехавший в датасет. Поэтому она
 * вынесена и проверяется числами, без браузера и без декодера.
 */

export interface PlanChunk {
  n: number;
  /** Номер первого кадра перегона в ролике. */
  first: number;
  count: number;
}

/** Кусок одного перегона: скормить кадры с ``from`` по ``to`` включительно. */
export interface Span {
  chunk: number;
  from: number;
  to: number;
}

export interface Plan {
  spans: Span[];
  /** Где остановились: отсюда кормить в следующий раз. */
  chunk: number;
  fed: number;
  /** Перегон, которого не хватило: его надо заказать. */
  wantNext: number | null;
}

/**
 * @param chunks   перечень перегонов ролика, как его объявил сервер
 * @param chunkNo  перегон, по которому кормим сейчас
 * @param fed      сколько кадров этого перегона уже скормлено
 * @param last     последний нужный кадр **в номерах ролика**
 * @param ready    можно ли досыпать этот перегон: байты на руках и поток тот же
 */
export function feedPlan(
  chunks: PlanChunk[],
  chunkNo: number,
  fed: number,
  last: number,
  ready: (n: number) => boolean
): Plan {
  const spans: Span[] = [];
  let here = chunks[chunkNo];
  let from = fed;

  if (!here) return { spans, chunk: chunkNo, fed, wantNext: null };

  for (;;) {
    const to = Math.min(here.count - 1, last - here.first);
    if (to >= from) spans.push({ chunk: here.n, from, to });
    const next = Math.max(from, to + 1);

    // В этом перегоне ещё есть чем кормить — значит вперёд забежали достаточно.
    if (next < here.count) return { spans, chunk: here.n, fed: next, wantNext: null };
    // Перегон кончился, но дальше и не просили.
    if (here.first + here.count > last) {
      return { spans, chunk: here.n, fed: next, wantNext: null };
    }

    const after = chunks[here.n + 1];
    // Ролик кончился — переходить некуда.
    if (!after) return { spans, chunk: here.n, fed: next, wantNext: null };
    if (!ready(after.n)) {
      // Байты ещё едут. Перескакивать через неприехавший перегон нельзя:
      // потерялся бы кусок ролика, а кадры после него поехали бы не с того
      // опорного.
      return { spans, chunk: here.n, fed: next, wantNext: after.n };
    }

    here = after;
    from = 0;
  }
}
