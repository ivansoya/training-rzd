// Железо: карты, что на них лежит и кто ждёт.
//
// Не этап конвейера, а то, что лежит под всеми тремя. Свою строку очереди
// видит каждый — иначе ожидание необъяснимо; весь экран видит только
// обслуживание.

import { useCallback, useEffect, useState } from "react";
import * as api from "../../api/gpu";
import type { Device, GpuState } from "../../api/gpu";
import Sep from "../Sep";

const gb = (mb: number) => `${(mb / 1024).toFixed(1).replace(".", ",")} ГБ`;

const KIND: Record<string, string> = {
  train: "обучение",
  embed: "признаки кадров",
  infer: "проверка модели",
  sam2: "полуавтомат",
};

const COLOUR: Record<string, string> = {
  train: "#6aa8ff",
  embed: "#2ee07a",
  infer: "#b48cff",
};

function ago(iso: string | null) {
  if (!iso) return "не отзывалась";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 90) return `${secs} с назад`;
  if (secs < 5400) return `${Math.round(secs / 60)} мин назад`;
  return `${Math.round(secs / 3600)} ч назад`;
}

function Card({
  device,
  onLimit,
}: {
  device: Device;
  onLimit: (data: { reserved_mb?: number; max_heavy?: number }) => void;
}) {
  const used = device.sam2_reserve_mb + device.held_mb;
  const pct = (mb: number) => `${(mb / device.total_mb) * 100}%`;

  return (
    <div className="t-side">
      <div className="t-run-head" style={{ marginBottom: 10 }}>
        <b style={{ fontSize: 13.5 }}>
          Карта {device.index} <Sep /> {device.name}
        </b>
        <span className={`t-pill ${device.held_mb ? "ok" : "idle"}`}>
          <i />
          {device.held_mb ? "занята" : "свободна"}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--dim)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {gb(used)} из {gb(device.total_mb)}
        </span>
      </div>

      <div className="t-split" style={{ height: 20, borderRadius: 4 }}>
        {device.sam2_reserve_mb > 0 && (
          <i
            style={{ width: pct(device.sam2_reserve_mb), background: "#ffb02e" }}
            title="полуавтомат SAM2"
          />
        )}
        {device.holders.map((h) => (
          <i
            key={h.id}
            style={{
              width: pct(h.granted_mb),
              background: COLOUR[h.kind] ?? "var(--dim)",
            }}
            title={h.title ?? KIND[h.kind] ?? h.kind}
          />
        ))}
        <i
          style={{ width: pct(device.reserved_mb), background: "var(--rule)" }}
          title="неприкосновенный запас"
        />
      </div>

      <div className="t-legend" style={{ marginTop: 9 }}>
        {device.sam2_reserve_mb > 0 && (
          <span>
            <u style={{ background: "#ffb02e" }} />
            полуавтомат SAM2 <b>{gb(device.sam2_reserve_mb)}</b>
          </span>
        )}
        {device.holders.map((h) => (
          <span key={h.id}>
            <u style={{ background: COLOUR[h.kind] ?? "var(--dim)" }} />
            {h.title ?? KIND[h.kind] ?? h.kind} <b>{gb(h.granted_mb)}</b>
          </span>
        ))}
        <span>
          <u style={{ background: "var(--rule)" }} />
          запас <b>{gb(device.reserved_mb)}</b>
        </span>
      </div>

      <div
        className="mag-field-row"
        style={{
          marginTop: 13,
          paddingTop: 12,
          borderTop: "1px solid var(--hair)",
          gridTemplateColumns: "1fr 1fr",
        }}
      >
        <div className="mag-field" style={{ marginBottom: 0 }}>
          <label htmlFor={`res-${device.id}`}>Неприкосновенный запас, ГБ</label>
          <input
            id={`res-${device.id}`}
            type="number"
            min={0}
            max={Math.round(device.total_mb / 1024)}
            step={0.5}
            defaultValue={(device.reserved_mb / 1024).toFixed(1)}
            onBlur={(e) =>
              onLimit({ reserved_mb: Math.round(Number(e.target.value) * 1024) })
            }
          />
        </div>
        <div className="mag-field" style={{ marginBottom: 0 }}>
          <label htmlFor={`heavy-${device.id}`}>Тяжёлых задач на карту</label>
          <input
            id={`heavy-${device.id}`}
            type="number"
            min={1}
            max={4}
            defaultValue={device.max_heavy}
            onBlur={(e) => onLimit({ max_heavy: Number(e.target.value) })}
          />
        </div>
      </div>

      <p className="mag-sub" style={{ marginTop: 8 }}>
        Два обучения по памяти влезут, но станут вдвое медленнее каждое — и оба
        человека решат, что сервер сломался. Последний отклик: {ago(device.seen_at)}.
      </p>
    </div>
  );
}

export default function HardwarePage() {
  const [state, setState] = useState<GpuState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.gpuState());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (error) return <div className="mag-content"><div className="mag-error">{error}</div></div>;
  if (!state) return <div className="mag-content mag-empty">Смотрю на карты…</div>;

  const queue = state.staff ? state.queue.queue : state.queue.mine;

  return (
    <div className="mag-content">
      <div className="mag-pass-strip">
        <div className="mag-pass-id">
          <h1 className="mag-h1">Железо</h1>
          <p>
            Карта одна на всех, и порядок к ней решает диспетчер, а не тот, кто
            первым нажал кнопку. У каждой строки очереди написано, чего ей не
            хватает: молчаливое ожидание — худший ответ из возможных.
          </p>
        </div>
      </div>

      {!state.staff && (
        <div className="t-warn">
          Подробности по картам видит обслуживание. Ниже — только ваши задачи.
        </div>
      )}

      {state.staff && state.devices.length === 0 && (
        <div className="mag-empty-big">
          <b>Видеокарт на сервере нет.</b>
          <p>
            Это не поломка: всё считает процессор, и диспетчер ничего не
            ограничивает. Если карта должна быть — проверьте, поднялся ли
            воркер обучения: карты перечисляет он.
          </p>
        </div>
      )}

      {state.devices.map((d) => (
        <Card
          key={d.id}
          device={d}
          onLimit={async (data) => {
            await api.setLimits(d.id, data).catch((e) =>
              setError((e as Error).message)
            );
            refresh();
          }}
        />
      ))}

      <div className="t-side" style={{ marginTop: 14 }}>
        <div className="g-label">
          Очередь <Sep /> {state.queue.total}{" "}
          {state.queue.total === 1 ? "задача" : "задач"}
        </div>
        {queue.length === 0 ? (
          <p className="mag-sub" style={{ marginTop: 8 }}>
            Никто не ждёт.
          </p>
        ) : (
          <div className="t-rows" style={{ marginTop: 10 }}>
            {queue.map((row) => (
              <div
                className="t-row"
                key={row.id}
                style={
                  row.mine
                    ? { background: "var(--red-in)", borderColor: "var(--red)" }
                    : undefined
                }
              >
                <div>
                  <div className="name">
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        color: row.mine ? "var(--red)" : "var(--faint)",
                      }}
                    >
                      {row.position}
                    </span>
                    {row.title ?? KIND[row.kind] ?? row.kind}
                    {row.mine && <span className="t-pill wait">ваша</span>}
                  </div>
                  <div className="meta">
                    просит <b>{gb(row.want_mb)}</b><Sep /> ждёт{" "}
                    <b>{Math.round(row.waiting_seconds / 60)} мин</b>
                    {row.reason ? ` — ${row.reason}` : ""}
                  </div>
                </div>
                <div className="right">
                  {state.staff && (
                    <button
                      type="button"
                      className="mag-ghost"
                      onClick={async () => {
                        await api.killLease(row.id).catch((e) =>
                          setError((e as Error).message)
                        );
                        refresh();
                      }}
                    >
                      Снять
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {state.staff && (
        <p className="mag-sub" style={{ marginTop: 12 }}>
          Живая связь: занято {state.live.used} мест из {state.live.hard},
          сейчас открыто до {state.live.soft}. Сверх потолка вкладки честно
          переходят на опрос и говорят об этом человеку.
        </p>
      )}
    </div>
  );
}
