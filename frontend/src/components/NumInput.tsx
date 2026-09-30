import { useEffect, useRef, useState } from "react";
import type { InputHTMLAttributes, KeyboardEvent } from "react";

/** Числовое поле, которое не перебивает набор.
 *
 *  Прежние поля были управляемыми по числу: пустое или промежуточное
 *  значение («», «0.», «-») тут же превращалось в умолчание, и набор
 *  продолжался поверх него — «0.4» становилось 0,254, «16» — 116, «5» — 15.
 *  Здесь текст поля живёт своей жизнью, пока в поле фокус; наружу уходит
 *  только разобранное число. Запятая и точка равноправны. Границы
 *  применяются на уходе из поля, а не на каждой букве: иначе «1» по дороге к
 *  «16» упёрлось бы в минимум 5.
 *
 *  `lazy` — отдавать число только на уходе из поля и по Enter: для полей, где
 *  каждое значение уходит на сервер. */
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max" | "step"> & {
  value: number | undefined | null;
  onValue: (n: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Пустое поле — это «не задано», а не ошибка. */
  allowEmpty?: boolean;
  /** Округлять до целого. */
  integer?: boolean;
  lazy?: boolean;
};

export function parseNum(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const fmt = (n: number | undefined | null) => (n == null || !Number.isFinite(n) ? "" : String(n).replace(".", ","));

export function NumInput({ value, onValue, min, max, step = 1, allowEmpty, integer, lazy, onBlur, onKeyDown, ...rest }: Props) {
  const [text, setText] = useState(fmt(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(fmt(value));
  }, [value]);

  const clamp = (n: number) => {
    let v = integer ? Math.round(n) : n;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    return v;
  };

  const commit = (t: string) => {
    const n = parseNum(t);
    if (n == null) {
      if (allowEmpty && t.trim() === "") {
        if (value != null) onValue(undefined);
        setText("");
      } else setText(fmt(value));
      return;
    }
    const v = clamp(n);
    if (v !== value) onValue(v);
    setText(fmt(v));
  };

  const nudge = (dir: 1 | -1) => {
    const base = parseNum(text) ?? value ?? min ?? 0;
    // Шаг 0,05 от 0,25 даёт 0,30000000000000004 — округляем до знаков шага.
    const digits = (String(step).split(".")[1] ?? "").length;
    const v = clamp(Number((base + dir * step).toFixed(digits)));
    setText(fmt(v));
    onValue(v);
  };

  return (
    <input
      {...rest}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      onFocus={(e) => {
        editing.current = true;
        rest.onFocus?.(e);
      }}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (lazy) return;
        const n = parseNum(t);
        // Вне границ наружу не отдаём: на уходе из поля число прижмётся.
        if (n != null && (min == null || n >= min) && (max == null || n <= max) && (!integer || Number.isInteger(n))) {
          if (n !== value) onValue(n);
        }
      }}
      onBlur={(e) => {
        editing.current = false;
        commit(text);
        onBlur?.(e);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") commit(text);
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          nudge(e.key === "ArrowUp" ? 1 : -1);
        }
        onKeyDown?.(e);
      }}
    />
  );
}
