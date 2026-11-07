import { useEffect, useState } from "react";
import { Button, Icon, Select, useEscape } from "../../ui";
import { errorText, rejectVideoAgentRange } from "../../auth/api";
import type { AgentRejectPreview, AgentRejectRange } from "../../auth/api";
import { NumInput } from "../NumInput";
import { count } from "../ru";
import { fmtFrameTime, frameToMs } from "../mag/trackMath";

export default function RejectRangeBar({ taskId, videoId, range, lastFrame, fps, onRange, onClose, onReject, onBusy }: {
  taskId: string;
  videoId: string;
  range: AgentRejectRange;
  lastFrame: number;
  fps: number;
  onRange: (range: AgentRejectRange) => void;
  onClose: () => void;
  onReject: (range: AgentRejectRange) => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [agent, setAgent] = useState("all");
  const [preview, setPreview] = useState<{ key: string; data: AgentRejectPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEscape(() => { if (!busy) onClose(); });
  const { from_frame: from, to_frame: to } = range;
  const valid = Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to <= lastFrame;
  const key = `${from}:${to}:${agent}:${retry}`;
  const ready = preview?.key === key ? preview.data : null;

  useEffect(() => {
    let live = true;
    setError(null);
    if (!valid) return;
    const timer = window.setTimeout(() => {
      rejectVideoAgentRange(taskId, videoId, { from_frame: from, to_frame: to,
        ...(agent === "all" ? {} : { agent_id: agent }) }, true)
        .then((data) => { if (live) setPreview({ key, data }); })
        .catch((e) => { if (live) setError(errorText(e)); });
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [taskId, videoId, from, to, agent, valid, key]);

  const submit = async () => {
    if (!ready?.boxes || busy || !valid) return;
    setBusy(true); onBusy(true); setError(null);
    try {
      await onReject({ from_frame: from, to_frame: to, ...(agent === "all" ? {} : { agent_id: agent }) });
    } catch (e) { setError(errorText(e)); setPreview(null); }
    finally { setBusy(false); onBusy(false); }
  };

  return (
    <div className="ve-reject-bar" role="group" aria-label="Отклонение на участке">
      <fieldset disabled={busy} className="ve-reject-fields">
        <Icon name="cut" size={14} className="is-agent" />
        <span className="t-muted t-xs">Кадры</span>
        <NumInput className="ui-input" aria-label="От кадра" title={fmtFrameTime(frameToMs(from, fps))}
          value={from} min={0} max={lastFrame} integer
          onValue={(v) => { if (v != null) onRange({ from_frame: v, to_frame: to }); }} />
        <span className="t-faint">–</span>
        <NumInput className="ui-input" aria-label="До кадра включительно" title={fmtFrameTime(frameToMs(to, fps))}
          value={to} min={0} max={lastFrame} integer
          onValue={(v) => { if (v != null) onRange({ from_frame: from, to_frame: v }); }} />
        <Select label="Агент на участке" value={agent} onChange={setAgent} disabled={busy} size="sm"
          options={[{ value: "all", label: "Все агенты" },
            ...(preview?.data.agents ?? []).map((a) => ({ value: a.id, label: a.name }))]} />
      </fieldset>
      <span className="ve-reject-summary" role="status" title="Непроверенные предложения всех классов; ручная и принятая разметка сохранятся.">
        {!valid ? "Конец раньше начала" : error ? error
          : ready ? ready.boxes ? `${count(ready.boxes, "объект", "объекта", "объектов")} на ${count(ready.frames, "кадре", "кадрах", "кадрах")}`
            : "Нет непроверенных объектов" : "Считаю…"}
      </span>
      {error && <Button variant="ghost" size="sm" icon="refresh" aria-label="Повторить подсчёт" disabled={busy}
        onClick={() => setRetry((n) => n + 1)} />}
      <Button variant="agent" size="sm" icon="trash" disabled={!valid || !ready?.boxes || busy || !!error} onClick={() => void submit()}>
        {busy ? "Отклоняю…" : "Отклонить"}
      </Button>
      <Button variant="ghost" size="sm" icon="x" aria-label="Отменить выбор участка" title="Отменить выбор участка (Esc)"
        disabled={busy} onClick={onClose} />
    </div>
  );
}
