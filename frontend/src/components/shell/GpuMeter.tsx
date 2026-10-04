import { Link } from "react-router-dom";
import { Icon, Legend, StackBar } from "../../ui";
import { deviceParts, gb, useGpuState } from "./useGpuState";

/** Видеопамять внизу сайдбара. Карты видит обслуживание, остальные — свою очередь. */
export default function GpuMeter() {
  const state = useGpuState();
  if (!state) return null;

  if (state.staff) {
    return (
      <>
        {state.devices.map((d) => {
          const parts = deviceParts(d);
          return (
            <Link key={d.id} to="/hardware" className="sb-gpu" title="Оборудование">
              <span className="sb-gpu-h">
                <span className="sb-gpu-n"><Icon name="cpu" size={14} />{d.name}</span>
                <span className="ui-mono">{gb(d.total_mb - d.free_mb)} / {gb(d.total_mb)} ГБ</span>
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
