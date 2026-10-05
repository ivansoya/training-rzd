import { useEffect, useRef, useState } from "react";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Число, которое доезжает до значения: с нуля при появлении, с прежнего — при смене. */
export function useTween(value: number, ms = 900): number {
  const [shown, setShown] = useState(() => (reduced() ? value : 0));
  const from = useRef(shown);
  useEffect(() => {
    if (reduced()) { from.current = value; setShown(value); return; }
    const start = from.current, t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const v = start + (value - start) * (1 - Math.pow(1 - k, 3));
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}
