// Личная библиотека графов. Живёт вне проектов: удачный граф переносят из
// проекта в проект, и копия разошлась бы с оригиналом на первой же правке.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as api from "../../api/aug";
import { mult } from "./counts";
import { count } from "../ru";
import Banner from "../Banner";

export default function AugGraphList() {
  // null — список ещё не пришёл. Пустой массив до ответа показывал «Графов
  // пока нет» на полсекунды даже тому, у кого их десяток.
  const [graphs, setGraphs] = useState<api.GraphSummary[] | null>(null);
  // Архив — отдельный список: граф, по которому собран набор, удалить
  // нельзя (паспорт набора ссылается на его версии), но убрать с глаз можно.
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      setGraphs((await api.listGraphs("aug", archived)).graphs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [archived]);

  useEffect(() => {
    setGraphs(null);
    refresh();
  }, [refresh]);

  /** Завести граф и сразу открыть его.
   *
   *  Имя здесь не спрашиваем. Раньше кнопка разворачивала полосу с полем и
   *  двумя кнопками во всю ширину страницы — ради одного слова, которое всё
   *  равно придумывают уже на холсте, глядя на собранное. Имя правится в
   *  шапке редактора, а свободный номер не даёт двум черновикам столкнуться.
   */
  const create = async () => {
    if (making) return;
    setMaking(true);
    setError(null);
    try {
      // Имя держат только живые графы — и из архива смотрим на них же.
      const taken = new Set((await api.listGraphs("aug")).graphs.map((g) => g.name));
      let name = "Новый граф";
      for (let n = 2; taken.has(name); n++) name = `Новый граф ${n}`;
      const got = await api.createGraph(name);
      navigate(`/augment/${got.id}`);
    } catch (e) {
      setError((e as Error).message);
      setMaking(false);
    }
  };

  /** Удалить граф. Граф, по которому собран набор, сервер не отдаст (409) —
   *  паспорт набора ссылается на его версии; причину он пишет сам. */
  const remove = async (g: api.GraphSummary) => {
    if (!window.confirm(`Удалить граф «${g.name}» со всеми версиями?`)) return;
    setWorking(g.id);
    setError(null);
    try {
      await api.deleteGraph(g.id);
      setGraphs((old) => (old ?? []).filter((x) => x.id !== g.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };

  /** В архив и обратно. Архивный граф не предлагается ни в проекте, ни в
   *  мастере набора; наборы, собранные по нему, остаются как были. */
  const shelve = async (g: api.GraphSummary, away: boolean) => {
    if (away && !window.confirm(`Убрать граф «${g.name}» в архив?`)) return;
    setWorking(g.id);
    setError(null);
    try {
      await api.patchGraph(g.id, { archived: away });
      setGraphs((old) => (old ?? []).filter((x) => x.id !== g.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="mag-content">
      <div className="mag-pass-strip">
        <div className="mag-pass-id">
          <h1 className="mag-h1">{archived ? "Аугментации — архив" : "Аугментации"}</h1>
        </div>
        <div className="mag-pass-export g-lib-acts">
          <button
            className="mag-ghost"
            type="button"
            aria-pressed={archived}
            onClick={() => setArchived((v) => !v)}
          >
            {archived ? "← Мои графы" : "Архив"}
          </button>
          {!archived && (
            <button className="mag-btn" type="button" disabled={making} onClick={create}>
              Новый граф
            </button>
          )}
        </div>
      </div>

      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

      {graphs === null ? null : graphs.length === 0 ? (
        archived ? (
          <div className="mag-empty-big">
            <b>В архиве пусто.</b>
          </div>
        ) : (
          <div className="mag-empty-big">
            <b>Графов пока нет.</b>
            <p>Источник, пара аугментаций и выход.</p>
            <button className="mag-btn" type="button" disabled={making}
              onClick={create}>
              Собрать первый граф
            </button>
          </div>
        )
      ) : (
        <div className="g-graphs">
          {graphs.map((g) => (
            // Карточка — не ссылка целиком: кнопку внутри ссылки класть
            // нельзя. Ссылка растянута на всю карточку, кнопка лежит поверх.
            <div key={g.id} className="g-graph-card">
              <Link to={`/augment/${g.id}`} className="name">{g.name}</Link>
              {g.description && <span className="desc">{g.description}</span>}
              <span className="foot">
                <span>версия {g.version}</span>
                {g.stats && <b>{mult(g.stats.multiplier)}</b>}
                <span>{count(g.stats?.nodes ?? 0, "узел", "узла", "узлов")}</span>
                {g.used_by_sets > 0 && (
                  <span>в наборах: {g.used_by_sets}</span>
                )}
              </span>
              <span className="g-graph-acts">
                <button
                  type="button"
                  className="g-graph-del g-graph-shelf"
                  disabled={working === g.id}
                  onClick={() => shelve(g, !archived)}
                >
                  {archived ? "Вернуть" : "В архив"}
                </button>
                <button
                  type="button"
                  className="g-graph-del"
                  disabled={working === g.id}
                  onClick={() => remove(g)}
                >
                  Удалить
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
