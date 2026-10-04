import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../../api/gpu";
import type { GpuState } from "../../api/gpu";
import { Icon, Legend, StackBar } from "../../ui";

const gb = (mb: number) => (mb / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 });

const KIND: Record<string, [string, string]> = {
  train: ["Обучение", "var(--c1)"],
  embed: ["Признаки", "var(--c2)"],
  infer: ["Проверка", "var(--c3)"],
};
const SAM2 = "var(--c4)";
const RESERVE = "var(--input)";
const FREE = "color-mix(in srgb, var(--muted-fg) 22%, var(--card))";

/** Видеопамять внизу сайдбара. Карты видит обслуживание, остальные — свою очередь. */
export default function GpuMeter() {
  const [state, setState] = useState<GpuState | null>(null);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const s = await api.gpuState();
        if (alive) setState(s);
      } catch { /* сайдбар молчит: подробности на странице «Оборудование» */ }
    };
    const loop = () => { void tick(); timer = window.setTimeout(loop, 10_000); };
    loop();
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!state) return null;

  if (state.staff) {
    return (
      <>
        {state.devices.map((d) => {
          const byKind = new Map<string, number>();
          for (const h of d.holders) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + h.granted_mb);
          const parts = [
            ...(d.sam2_reserve_mb > 0 ? [{ label: `SAM2 ${gb(d.sam2_reserve_mb)}`, value: d.sam2_reserve_mb, color: SAM2 }] : []),
            ...[...byKind].map(([k, mb]) => ({
              label: `${KIND[k]?.[0] ?? k} ${gb(mb)}`, value: mb, color: KIND[k]?.[1] ?? "var(--c5)",
            })),
            ...(d.reserved_mb > 0 ? [{ label: `Запас ${gb(d.reserved_mb)}`, value: d.reserved_mb, color: RESERVE }] : []),
            { label: `Свободно ${gb(d.free_mb)}`, value: d.free_mb, color: FREE },
          ];
          const used = d.total_mb - d.free_mb;
          return (
            <Link key={d.id} to="/hardware" className="sb-gpu" title="Оборудование">
              <span className="sb-gpu-h">
                <span className="sb-gpu-n"><Icon name="cpu" size={14} />{d.name}</span>
                <span className="ui-mono">{gb(used)} / {gb(d.total_mb)} ГБ</span>
              </span>
              <StackBar parts={parts} height={8} />
              <Legend items={parts.map((p) => ({ label: p.label, color: p.color }))} />
            </Link>
          );
        })}
      </>
    );
  }

  const mine = state.queue.mine;
  if (!mine.length) return null;
  const first = Math.min(...mine.map((q) => q.position));
  return (
    <Link to="/hardware" className="sb-gpu">
      <span className="sb-gpu-n"><Icon name="clock" size={14} />В очереди к карте</span>
      <span className="ui-hint">
        {mine.length === 1 ? `Ваша задача ${first}-я` : `Ваших задач ${mine.length}, первая — ${first}-я`}
      </span>
    </Link>
  );
}
