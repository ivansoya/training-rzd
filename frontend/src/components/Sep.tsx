import { Fragment } from "react";
import type { ReactNode } from "react";

/** Разделитель между кусками одной строки.
 *
 * Раньше это была точка в тексте. Точка съезжает с базовой линии, в разных
 * шрифтах рисуется по-разному и на плотной строке читается как опечатка.
 * Здесь её место занимает черта, нарисованная CSS: она берёт цвет из тех же
 * токенов, что и все прочие линии, и выравнивается по высоте строки.
 *
 * Скрытая запятая — для читалок и копирования: без неё соседние куски слипаются в одно слово.
 */
export default function Sep() {
  return <i className="sep"><span className="ui-sr">, </span></i>;
}

/** Куски строки через черту; пустые (null, false, "") выпадают — как было с filter(Boolean).join(" · "). */
export function withSep(parts: ReactNode[]): ReactNode {
  const kept = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "");
  // Пусто — null, а не []: иначе `withSep(...) || "запасной текст"` не сработает
  return kept.length ? kept.map((p, i) => <Fragment key={i}>{i > 0 && <Sep />}{p}</Fragment>) : null;
}
