import { Link } from "react-router-dom";
import { Icon, Legend, StackBar } from "../../ui";
import { deviceParts, gb, liveDevices, shortName, useGpuState } from "./useGpuState";

/** Видеопамять внизу сайдбара. Сводку карт видят все; по видам работ — с правом на оборудование. */
export default function GpuMeter() {
  const state = useGpuState();
  if (!state) return null;
  const mine = state.queue.mine;
  const first = mine.length ? Math.min(...mine.map((q) => q.position)) : 0;
  return (
    <>
      {liveDevices(state).map((d) => {
        const parts = deviceParts(d);
        return (
          <Link key={d.id} to="/hardware" className="sb-gpu" title="Оборудование">
            <span className="sb-gpu-h">
              <span className="sb-gpu-n"><Icon name="cpu" size={14} />{shortName(d.name)}</span>
              <span className="ui-mono">{gb(d.total_mb - d.free_mb)} / {gb(d.total_mb)} ГБ</span>
            </span>
            <StackBar parts={parts} height={8} />
            <Legend items={parts.map((p) => ({ label: p.label, color: p.color }))} />
          </Link>
        );
      })}
      {mine.length > 0 && (
        <Link to="/hardware" className="sb-gpu">
          <span className="sb-gpu-n"><Icon name="clock" size={14} />В очереди к карте</span>
          <span className="ui-hint">
            {mine.length === 1 ? `Ваша задача ${first}-я` : `Ваших задач ${mine.length}, первая — ${first}-я`}
          </span>
        </Link>
      )}
    </>
  );
}
