// Обучающие наборы проекта. Прогоны живут отдельно — /runs; «Учить» открывает окно запуска.

import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import * as setsApi from "../../api/trainsets";
import type { TrainSet } from "../../api/trainsets";
import { useLive } from "../../live/LiveProvider";
import RunDialog from "../mag/runs/RunDialog";
import Sep from "../Sep";
import Banner from "../Banner";

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

export default function TrainingHome() {
  const { code } = useParams<{ code: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  // null — ответа ещё нет. С пустым массивом до ответа на полсекунды
  // мелькало «Обучающих наборов пока нет» у проекта с десятком наборов.
  const [sets, setSets] = useState<TrainSet[] | null>(null);
  // Набор, который сейчас удаляется по щелчку: двойной щелчок слал два DELETE.
  const [removing, setRemoving] = useState<string | null>(null);
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<{ setId: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!code) return;
    try {
      const s = await setsApi.listSets(code);
      setSets(s.sets);
      setRole(s.role);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useLive("*", (event) => {
    if (["prep", "*"].includes(event.k)) refresh();
  });

  // Пока что-то собирается, страница обновляется сама и без живой связи
  useEffect(() => {
    const busy = (sets ?? []).some((s) => ["building", "queued", "deleting"].includes(s.status));
    if (!busy) return;
    const timer = window.setInterval(refresh, 2500);
    return () => window.clearInterval(timer);
  }, [sets, refresh]);

  const canEdit = role === "admin" || role === "editor";

  if (search.get("tab") === "runs") return <Navigate replace to={`/projects/${code}/runs`} />;

  return (
    <>
      <div className="t-tabs">
        <span className="t-tab on">
          Наборы <b>{sets?.length ?? "—"}</b>
        </span>
        <Link className="t-tab" to={`/projects/${code}/runs`}>Обучения</Link>
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

      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

      {sets &&
        (sets.length === 0 ? (
          <div className="mag-empty-big">
            <b>Обучающих наборов пока нет.</b>
            <p>Обучение идёт из набора, а не напрямую из датасета.</p>
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
                          {s.graph.name} <Sep /> v{s.graph.version}
                        </span>
                      )}
                    </div>
                    <div className="meta">
                      {s.counts ? (
                        <>
                          образцов <b>{ru(s.counts.samples)}</b><Sep /> обучение{" "}
                          <b>{ru(s.counts.train)}</b><Sep /> проверка{" "}
                          <b>{ru(s.counts.val)}</b><Sep />{" "}
                          {s.kind === "polygon" ? "сегментация" : "рамки"}
                          {/* «0 Б» у набора целиком из ссылок читался как
                              «пустой»: место он не занимает, но кадры в нём
                              есть. Ноль не пишем, ссылки подписаны. */}
                          {s.size_bytes > 0 && (
                            <><Sep /> занимает <b>{bytes(s.size_bytes)}</b></>
                          )}
                          {s.hardlinked_bytes > 0 && (
                            <><Sep /> ссылками {bytes(s.hardlinked_bytes)}</>
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
                          {job.stage_text ?? "готовлю"} <Sep /> {ru(job.processed)} из{" "}
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
                        onClick={() => setStarting({ setId: s.id })}
                      >
                        Учить
                      </button>
                    )}
                    {canEdit && s.status !== "deleting" && (
                      <button
                        type="button"
                        className="mag-ghost"
                        disabled={removing !== null}
                        onClick={async () => {
                          if (!code || removing) return;
                          if (
                            !confirm(
                              `Удалить набор «${s.name}»? Файлы уйдут с диска.` +
                                " Обучения на нём останутся, с весами и метриками."
                            )
                          )
                            return;
                          setRemoving(s.id);
                          await setsApi.deleteSet(code, s.id).catch((e) =>
                            setError((e as Error).message)
                          );
                          await refresh();
                          setRemoving(null);
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

      {starting && code && (
        <RunDialog
          code={code}
          seed={starting}
          onClose={() => setStarting(null)}
          onStarted={(r) => navigate(`/projects/${code}/runs/${r.number}`)}
        />
      )}
    </>
  );
}
