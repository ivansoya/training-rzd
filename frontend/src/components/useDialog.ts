import { useEffect, useRef } from "react";

/** Фокус модалки: при открытии — внутрь, Tab не уходит на страницу позади,
 *  при закрытии — туда, где был.
 *
 *  Проверка нашла: «Новый проект» открывался с фокусом на кнопке за
 *  подложкой, а после пяти Tab фокус гулял по меню страницы под окном.
 *  Вешается на корень окна: `<div ref={useDialog()} role="dialog"
 *  aria-modal="true" tabIndex={-1}>`. Окна стоят стопкой, Tab держит верхнее. */
const stack: HTMLElement[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(box: HTMLElement) {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

function onKey(e: KeyboardEvent) {
  const box = stack[stack.length - 1];
  if (e.key !== "Tab" || !box) return;
  const f = focusables(box);
  if (!f.length) {
    e.preventDefault();
    return;
  }
  const first = f[0];
  const last = f[f.length - 1];
  const at = document.activeElement;
  if (!box.contains(at)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && at === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
}

export function useDialog<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const before = document.activeElement as HTMLElement | null;
    // autoFocus у поля срабатывает раньше эффекта — его не перебиваем.
    if (!box.contains(document.activeElement)) (focusables(box)[0] ?? box).focus();
    if (!stack.length) document.addEventListener("keydown", onKey);
    stack.push(box);
    return () => {
      const i = stack.lastIndexOf(box);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) document.removeEventListener("keydown", onKey);
      if (before && document.contains(before)) before.focus();
    };
  }, []);
  return ref;
}
