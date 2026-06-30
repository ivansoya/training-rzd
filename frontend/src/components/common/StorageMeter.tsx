import { useEffect, useState } from "react";
import { getStorage } from "../../api";
import type { StorageInfo } from "../../types";

// Sidebar-bottom disk meter: uploaded data size + free disk space, coloured
// yellow when space is getting low and red when it is nearly out.
export default function StorageMeter() {
  const [info, setInfo] = useState<StorageInfo | null>(null);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const s = await getStorage();
        if (active) setInfo(s);
      } catch {
        /* ignore */
      }
    };
    tick();
    const h = setInterval(tick, 20000);
    return () => {
      active = false;
      clearInterval(h);
    };
  }, []);

  if (!info) return null;

  const freeRatio = info.disk_total ? info.disk_free / info.disk_total : 1;
  const level = freeRatio < 0.07 ? "crit" : freeRatio < 0.15 ? "warn" : "ok";
  const usedRatio = info.disk_total ? info.disk_used / info.disk_total : 0;

  return (
    <div className={`storage-meter ${level}`}>
      <div className="storage-row">
        <span>Загруженные данные</span>
        <span className="mono">{human(info.uploaded_bytes)}</span>
      </div>
      <div className="storage-bar">
        <div
          className="storage-fill"
          style={{ width: `${Math.min(100, usedRatio * 100)}%` }}
        />
      </div>
      <div className="storage-row storage-free">
        <span>Свободно {human(info.disk_free)}</span>
        <span className="subtle">из {human(info.disk_total)}</span>
      </div>
    </div>
  );
}

function human(bytes: number): string {
  const g = bytes / 1e9;
  if (g >= 1) return `${g.toFixed(1)} ГБ`;
  return `${(bytes / 1e6).toFixed(0)} МБ`;
}
