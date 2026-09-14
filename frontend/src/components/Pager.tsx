/** Перелистывание страниц: стрелки по краям, номера посередине.
 *
 * Было две кнопки во всю ширину и «1 из 2», сдавленное между ними в столбик.
 * Две беды сразу: попасть на пятую страницу можно было только пятью нажатиями,
 * а сколько их всего — читалось по вертикали.
 *
 * Номера решают обе. Человек здесь ищет не «следующую», а конкретное место в
 * наборе: отложенные кадры в конце, спорную разметку где-то посередине. Номера
 * и показывают размер набора, и дают прыгнуть куда угодно за одно нажатие.
 *
 * Показываем не все: на сотне страниц список сам стал бы полотном. Края,
 * окрестность текущей и многоточие вместо пропуска — так видно и где ты, и
 * где границы.
 */

/** Какие номера показать: первая, последняя, текущая с соседями. Между
 *  разрывами — "gap", это не кнопка, а знак пропуска. */
function pageWindow(page: number, pages: number): (number | "gap")[] {
  const near = new Set<number>([0, pages - 1]);
  for (let p = page - 2; p <= page + 2; p += 1) {
    if (p >= 0 && p < pages) near.add(p);
  }
  const sorted = [...near].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((p, i) => {
    // Разрыв ровно в одну страницу многоточием не заменяем: «1 … 3» занимает
    // столько же места, сколько «1 2 3», но прячет страницу.
    if (i && p - sorted[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

export default function Pager({
  page,
  pages,
  onPage,
  disabled,
}: {
  /** Текущая страница, считая с нуля. */
  page: number;
  pages: number;
  onPage: (page: number) => void;
  /** Пока едут кадры — листать нечем. */
  disabled?: boolean;
}) {
  if (pages <= 1) return null;

  return (
    <nav className="mag-pager" aria-label="Страницы">
      <button className="mag-pager-step" type="button"
        disabled={page === 0 || disabled}
        onClick={() => onPage(page - 1)}>
        <span aria-hidden="true">←</span> Назад
      </button>

      <span className="mag-pager-nums">
        {pageWindow(page, pages).map((p, i) =>
          p === "gap" ? (
            <span key={`gap${i}`} className="mag-pager-gap" aria-hidden="true">…</span>
          ) : (
            <button
              key={p}
              type="button"
              className={p === page ? "mag-pager-n on" : "mag-pager-n"}
              // Страница, на которой стоим, — не ссылка: нажимать её незачем,
              // но и гасить нельзя, иначе она потеряется среди соседей.
              aria-current={p === page ? "page" : undefined}
              disabled={disabled}
              onClick={() => onPage(p)}
            >
              {p + 1}
            </button>
          )
        )}
      </span>

      <button className="mag-pager-step" type="button"
        disabled={page + 1 >= pages || disabled}
        onClick={() => onPage(page + 1)}>
        Дальше <span aria-hidden="true">→</span>
      </button>
    </nav>
  );
}
