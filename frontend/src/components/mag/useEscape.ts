import { useEffect, useRef } from "react";

/** Esc закрывает верхний слой — и только его.
 *
 *  Раньше каждый `useEscape` слушал окно сам по себе, и одно нажатие
 *  закрывало всё сразу: Esc в поиске тага уносил окно загрузки с выбранными
 *  файлами, Esc при открытой справке закрывал весь редактор. Теперь слои
 *  стоят стопкой: срабатывает последний открытый, а нажатие гасится ещё на
 *  погружении в `window` — ни поля ввода, ни редакторы под ним его не видят.
 *
 *  Всплывашка, у которой Esc был своим `onKeyDown`, заводит слой так же:
 *  `useEscape(close, open)` — иначе её перехватит модалка под ней.
 *
 *  Клик по фону взамен Esc ничего не закрывает — промах мышью не должен
 *  уносить набранное. */
const layers: { current: () => void }[] = [];

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !layers.length) return;
  e.preventDefault();
  e.stopPropagation();
  layers[layers.length - 1].current();
}

export function useEscape(onClose: () => void, active = true) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    if (!layers.length) window.addEventListener("keydown", onKey, true);
    layers.push(ref);
    return () => {
      const i = layers.lastIndexOf(ref);
      if (i >= 0) layers.splice(i, 1);
      if (!layers.length) window.removeEventListener("keydown", onKey, true);
    };
  }, [active]);
}
