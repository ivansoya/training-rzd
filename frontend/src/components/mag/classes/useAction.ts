import { useCallback, useRef, useState } from "react";

/** Одно действие за раз, ошибка — у себя. Замок в ref: второй щелчок приходит раньше перерисовки. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}
