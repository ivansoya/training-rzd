// Окно «на карте не запустится»: обучение или прогон агента больше любой карты либо карты
// выключены — запустить на процессоре или отменить (решения владельца 11.10.2026).
// Сервер отвечает на запуск 409 с кодом; согласие — тот же запрос с `device: "cpu"`.
import { ApiError } from "../../api/http";
import { Button, Dialog, Notice } from "../../ui";

export interface CardRefusal {
  code: "gpu_never" | "gpu_off";
  error: string;
  /** Обучению: что поправить, чтобы влезло на карту (по прикидке). */
  fit?: { batch?: number; imgsz?: number } | null;
}

/** Отказ карты из ошибки запуска — или null, если это другая ошибка. */
export function refusalOf(e: unknown): CardRefusal | null {
  if (e instanceof ApiError && e.status === 409 && (e.code === "gpu_never" || e.code === "gpu_off")) {
    return e.payload as CardRefusal;
  }
  return null;
}

export default function CpuConfirm({ refusal, busy, onCpu, onCancel, onFit }: {
  refusal: CardRefusal;
  busy: boolean;
  onCpu: () => void;
  onCancel: () => void;
  /** Только у обучения: вернуться в форму с поправленным батчем или входом. */
  onFit?: (fit: { batch?: number; imgsz?: number }) => void;
}) {
  const fit = onFit ? refusal.fit : null;
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onCancel(); }} width={600} title="На карте не запустится"
      footer={<>
        <Button variant="ghost" onClick={onCancel}>Отменить</Button>
        <span className="grow" />
        {fit && onFit && (
          <Button variant="outline" onClick={() => onFit(fit)}>
            {fit.imgsz ? `Поставить вход ${fit.imgsz}, батч 1` : `Поставить батч ${fit.batch}`}
          </Button>
        )}
        <Button variant="primary" icon="cpu" disabled={busy} onClick={onCpu}>
          {busy ? "Ставлю в очередь…" : "Запустить на процессоре"}
        </Button>
      </>}>
      <div className="stack-v">
        <Notice tone="warn">{refusal.error}</Notice>
        {fit && (
          <p className="t-sm">На карту влезет {fit.imgsz ? `вход до ${fit.imgsz} при батче 1` : `батч до ${fit.batch}`}.</p>
        )}
        <p className="t-sm t-muted">На процессоре сервер считает одну задачу разом — эта может встать в очередь.</p>
      </div>
    </Dialog>
  );
}
