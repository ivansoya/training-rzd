import { useEffect, useState } from "react";
import type { AutoState } from "./useAutoLabel";

/** Плашка полуавтомата над холстом — одна на редактор кадров и видеоредактор.
 *
 * Без неё отказ модели, ожидание ответа и подъём сессии были видны только в
 * ⚙ или в подсказке серой кнопки: клик «ничего не делал», и причина пряталась.
 */
export default function AutoStatus({
  state,
  error,
  busy,
  on,
  quiet,
  onRetry,
  onDismiss,
}: {
  state: AutoState;
  error: string | null;
  busy: boolean;
  /** Включён ли полуавтомат у разметчика. */
  on: boolean;
  /** Только просмотр: об отказе модели зрителю знать незачем. */
  quiet?: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  // Отказ сессии скрывается крестиком до следующей перемены состояния.
  const [hidden, setHidden] = useState(false);
  useEffect(() => setHidden(false), [state, error]);

  if (quiet || hidden) return null;
  if (state === "error") {
    return (
      <div className="mag-auto-plate err" role="alert">
        Полуавтомат недоступен: {error || "модель не поднялась"}
        <button type="button" onClick={onRetry}>Повторить</button>
        <button type="button" aria-label="Скрыть" onClick={() => setHidden(true)}>✕</button>
      </div>
    );
  }
  if (!on) return null;
  if (state === "starting") {
    return <div className="mag-auto-plate" role="status">{error || "Модель готовится…"}</div>;
  }
  if (busy) return <div className="mag-auto-plate" role="status">SAM2 думает…</div>;
  if (error) {
    return (
      <div className="mag-auto-plate err" role="alert">
        {error}
        <button type="button" aria-label="Скрыть" onClick={onDismiss}>✕</button>
      </div>
    );
  }
  return null;
}
