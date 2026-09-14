/** Плашка-уведомление с крестиком справа.
 *
 * Сообщение об успехе — событие, а не состояние страницы: «Пароль изменён»
 * верно ровно один раз, а висело до перезагрузки и мозолило глаза поверх
 * работы. Убрать его должно быть можно рукой, и крестик — то место, где
 * человек его ищет.
 *
 * Сам вид плашки берётся из `className` (`mag-ok`, `mag-error`, `mag-warn`,
 * `mag-ok-banner`): цвета у них разные и живут в общих стилях, а вот разметка
 * с кнопкой — одна на всех, иначе крестик разъедется по четырём местам на
 * первой же правке.
 *
 * Без `onClose` плашка остаётся просто плашкой: ошибка, которая и есть всё
 * содержимое экрана, закрываться не должна — за ней ничего нет.
 */
export default function Banner({
  className = "mag-ok",
  onClose,
  children,
}: {
  className?: string;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`${className}${onClose ? " mag-note" : ""}`}>
      <span>{children}</span>
      {onClose && (
        <button type="button" className="mag-note-x" onClick={onClose}
          title="Закрыть" aria-label="Закрыть">
          ×
        </button>
      )}
    </div>
  );
}
