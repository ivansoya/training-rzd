// Личная библиотека графов. Живёт вне проектов: удачный граф переносят из
// проекта в проект, и копия разошлась бы с оригиналом на первой же правке.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as api from "../../api/aug";
import Banner from "../Banner";

export default function AugGraphList() {
  const [graphs, setGraphs] = useState<api.GraphSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      setGraphs((await api.listGraphs()).graphs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
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
    const taken = new Set(graphs.map((g) => g.name));
    let name = "Новый граф";
    for (let n = 2; taken.has(name); n++) name = `Новый граф ${n}`;
    try {
      const got = await api.createGraph(name);
      navigate(`/augment/${got.id}`);
    } catch (e) {
      setError((e as Error).message);
      setMaking(false);
    }
  };

  return (
    <div className="mag-content">
      <div className="mag-pass-strip">
        <div className="mag-pass-id">
          <h1 className="mag-h1">Аугментации</h1>
        </div>
        <button
          className="mag-btn mag-pass-export"
          type="button"
          disabled={making}
          onClick={create}
        >
          Новый граф
        </button>
      </div>

      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

      {graphs.length === 0 ? (
        <div className="mag-empty-big">
          <b>Графов пока нет.</b>
          <p>Источник, пара аугментаций и выход.</p>
          <button className="mag-btn" type="button" disabled={making}
            onClick={create}>
            Собрать первый граф
          </button>
        </div>
      ) : (
        <div className="g-graphs">
          {graphs.map((g) => (
            <Link key={g.id} to={`/augment/${g.id}`} className="g-graph-card">
              <span className="name">{g.name}</span>
              {g.description && <span className="desc">{g.description}</span>}
              <span className="foot">
                <span>версия {g.version}</span>
                {g.stats && <b>×{g.stats.multiplier}</b>}
                <span>{g.stats?.nodes ?? 0} узлов</span>
                {g.used_by_sets > 0 && (
                  <span>в наборах: {g.used_by_sets}</span>
                )}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
