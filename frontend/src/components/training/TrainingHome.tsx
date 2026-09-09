// Раздел обучения проекта: наборы и обучения на них.
//
// Живая связь одна на вкладку: она приносит «изменился такой-то ран», а строку
// страница дочитывает сама. Соединение на каждое обучение занимало бы поток
// сервера на всё время прогона, причём девять из десяти — впустую.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import * as runsApi from "../../api/runs";
import * as setsApi from "../../api/trainsets";
import type { Run } from "../../api/runs";
import type { TrainSet } from "../../api/trainsets";
import { useLive } from "../../live/LiveProvider";
import StartRunModal from "./StartRunModal";

const ru = (n: number) => Math.round(n).toLocaleString("ru-RU");

const bytes = (n: number) => {
  if (n < 1024) return `${n} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${units[i]}`;
};

const SET_LOOK: Record<string, [string, string]> = {
  draft: ["idle", "черновик"],
  queued: ["wait", "в очереди"],
  building: ["run", "собирается"],
  ready: ["ok", "готов"],
  error: ["bad", "не собрался"],
  deleting: ["wait", "удаляется"],
};

const RUN_LOOK: Record<string, [string, string]> = {
  queued: ["wait", "в очереди"],
  waiting_gpu: ["wait", "ждёт видеокарту"],
  preparing: ["run", "готовится"],
  running: ["run", "идёт"],
  stopping: ["wait", "останавливается"],
  done: ["ok", "готово"],
  stopped: ["idle", "остановлено"],
  error: ["bad", "ошибка"],
};

export default function TrainingHome() {
  const { code } = useParams<{ code: string }>();
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") === "runs" ? "runs" : "sets";

  const [sets, setSets] = useState<TrainSet[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<TrainSet | null>(null);

  const refresh = useCallback(async () => {
    if (!code) return;
    try {
      const [s, r] = await Promise.all([
        setsApi.listSets(code),
        runsApi.listRuns(code),
      ]);
      setSets(s.sets);
      setRuns(r.runs);
      setRole(s.role);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useLive("run", refresh);
  useLive("prep", refresh);
  useLive("*", refresh);

  // Пока что-то собирается или учится, страница обновляется сама даже без
  // живой связи: сборка не шлёт события так часто, как обучение.
  useEffect(() => {
    const busy =
      sets.some((s) => ["building", "queued", "deleting"].includes(s.status)) ||
      runs.some((r) => !["done", "error", "stopped"].includes(r.status));
    if (!busy) return;
    const timer = window.setInterval(refresh, 2500);
    return () => window.clearInterval(timer);
  }, [sets, runs, refresh]);

  const canEdit = role === "admin" || role === "editor";

  return (
    <>
      <div className="t-tabs">
        <button
          type="button"
          className={`t-tab${tab === "sets" ? " on" : ""}`}
          onClick={() => setSearch({})}
        >
          Наборы <b>{sets.length}</b>
        </button>
        <button
          type="button"
          className={`t-tab${tab === "runs" ? " on" : ""}`}
          onClick={() => setSearch({ tab: "runs" })}
        >
          Обучения <b>{runs.length}</b>
        </button>
        {canEdit && (
          <Link
            to={`/projects/${code}/training/new`}
            className="mag-btn mag-btn-inline"
            style={{ marginLeft: "auto", alignSelf: "center" }}
          >
            Собрать набор
          </Link>
        )}
      </div>

      {error && <div className="mag-error">{error}</div>}

      {tab === "sets" &&
        (sets.length === 0 ? (
          <div className="mag-empty-big">
            <b>Обучающих наборов пока нет.</b>
            <p>
              Набор — это папка с кадрами и разметкой, поделённая на обучение и
              проверку. Учиться напрямую из датасета нельзя: деление и
              аугментации нужно где-то записать, иначе повторить обучение будет
              не на чем.
            </p>
            {canEdit && (
              <Link to={`/projects/${code}/training/new`} className="mag-btn">
                Собрать первый набор
              </Link>
            )}
          </div>
        ) : (
          <div className="t-rows">
            {sets.map((s) => {
              const [look, label] = SET_LOOK[s.status] ?? ["idle", s.status];
              const job = s.job;
              return (
                <div className="t-row" key={s.id}>
                  <div>
                    <div className="name">
                      {s.name}
                      <span className={`t-pill ${look}`}>
                        <i />
                        {label}
                      </span>
                      {s.graph && (
                        <span className="t-pill idle">
                          {s.graph.name} · v{s.graph.version}
                        </span>
                      )}
                    </div>
                    <div className="meta">
                      {s.counts ? (
                        <>
                          образцов <b>{ru(s.counts.samples)}</b> · обучение{" "}
                          <b>{ru(s.counts.train)}</b> · проверка{" "}
                          <b>{ru(s.counts.val)}</b> ·{" "}
                          {s.kind === "polygon" ? "сегментация" : "рамки"} ·{" "}
                          <b>{bytes(s.size_bytes)}</b>
                          {s.hardlinked_bytes > 0 && (
                            <> · ссылками {bytes(s.hardlinked_bytes)}</>
                          )}
                        </>
                      ) : s.error ? (
                        <span style={{ color: "var(--red)" }}>{s.error}</span>
                      ) : (
                        <>зерно {s.seed}</>
                      )}
                    </div>
                    {job && (
                      <>
                        <div className="t-bar">
                          <i
                            style={{
                              width: `${
                                job.total
                                  ? (job.processed / job.total) * 100
                                  : 5
                              }%`,
                            }}
                          />
                        </div>
                        <div className="meta">
                          {job.stage_text ?? "готовлю"} · {ru(job.processed)} из{" "}
                          {ru(job.total)}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="right">
                    {/* Посмотреть, что собралось, можно и наблюдателю: это
                        чтение, и до обучения оно нужнее всего. */}
                    {s.status === "ready" && (
                      <Link
                        className="mag-ghost"
                        to={`/projects/${code}/trainsets/${s.id}`}
                      >
                        Смотреть
                      </Link>
                    )}
                    {s.status === "ready" && canEdit && (
                      <button
                        type="button"
                        className="mag-btn"
                        onClick={() => setStarting(s)}
                      >
                        Учить
                      </button>
                    )}
                    {canEdit && s.status !== "deleting" && (
                      <button
                        type="button"
                        className="mag-ghost"
                        onClick={async () => {
                          if (!code) return;
                          if (
                            !confirm(
                              `Удалить набор «${s.name}»? Файлы уйдут с диска.` +
                                " Обучения на нём останутся, с весами и метриками."
                            )
                          )
                            return;
                          await setsApi.deleteSet(code, s.id).catch((e) =>
                            setError((e as Error).message)
                          );
                          refresh();
                        }}
                      >
                        {s.status === "error" && s.error?.startsWith("Удалить не вышло")
                          ? "Удалить снова"
                          : "Удалить"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}

      {tab === "runs" &&
        (runs.length === 0 ? (
          <div className="mag-empty-big">
            <b>Обучений пока не было.</b>
            <p>Соберите набор и запустите на нём обучение.</p>
          </div>
        ) : (
          <div className="t-rows">
            {runs.map((r) => {
              const [look, label] = RUN_LOOK[r.status] ?? ["idle", r.status];
              const busy = ["running", "preparing"].includes(r.status);
              return (
                <Link
                  className="t-row"
                  key={r.id}
                  to={`/projects/${code}/training/runs/${r.id}`}
                >
                  <div>
                    <div className="name">
                      {r.name}
                      <span className={`t-pill ${look}`}>
                        <i />
                        {label}
                        {busy && ` · эпоха ${r.current_epoch} из ${r.epochs}`}
                      </span>
                    </div>
                    <div className="meta">
                      {r.base_model} · {r.device} ·{" "}
                      {r.set ? `набор «${r.set.name}»` : "набор удалён"}
                      {r.author ? ` · ${r.author}` : ""}
                      {r.best_fitness !== null && (
                        <>
                          {" "}
                          · лучшая эпоха <b>{r.best_epoch}</b>
                        </>
                      )}
                    </div>
                    {r.status === "waiting_gpu" && r.queue_reason && (
                      <div className="meta" style={{ color: "var(--skip)" }}>
                        {r.queue_reason}
                      </div>
                    )}
                    {busy && (
                      <div className="t-bar">
                        <i
                          className="done"
                          style={{
                            width: `${(r.current_epoch / Math.max(1, r.epochs)) * 100}%`,
                          }}
                        />
                      </div>
                    )}
                  </div>
                  <div className="right">
                    {r.has_weights && <span className="t-pill ok">веса</span>}
                  </div>
                </Link>
              );
            })}
          </div>
        ))}

      {starting && code && (
        <StartRunModal
          code={code}
          set={starting}
          onClose={() => setStarting(null)}
          onStarted={() => {
            setStarting(null);
            setSearch({ tab: "runs" });
            refresh();
          }}
        />
      )}
    </>
  );
}
