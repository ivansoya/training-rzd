import { useEffect } from "react";

/** Esc закрывает модалку. Взамен клика по фону: тот больше не закрывает
 *  ничего, чтобы промах мышью не уносил набранное. */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}
