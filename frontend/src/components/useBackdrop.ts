import { useRef } from "react";
import type { MouseEvent } from "react";

/**
 * Щелчок по подложке модалки — целиком, а не по одному `click`.
 *
 * Выделяя текст внутри модалки, курсор почти всегда отпускают за её краем.
 * Браузер засчитывает такой `click` ближайшему общему предку нажатия и
 * отпускания — то есть подложке, — и `stopPropagation` на содержимом тут не
 * спасает: до него событие не доходит. Модалка закрывалась посреди выделения,
 * унося введённые параметры обучения.
 *
 * Поэтому закрываем, только когда на подложке произошло и нажатие, и
 * отпускание. Заодно отпадает `stopPropagation` у содержимого: щелчок внутри
 * приходит с чужим `target` и не проходит проверку.
 */
export function useBackdrop(onBackdrop: () => void) {
  const from = useRef<EventTarget | null>(null);
  return {
    onMouseDown: (e: MouseEvent) => {
      from.current = e.target;
    },
    onClick: (e: MouseEvent) => {
      if (e.target === e.currentTarget && from.current === e.currentTarget) {
        onBackdrop();
      }
    },
  };
}
