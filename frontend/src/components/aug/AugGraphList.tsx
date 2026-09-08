// Личная библиотека графов. Живёт вне проектов: удачный граф переносят из
// проекта в проект, и копия разошлась бы с оригиналом на первой же правке.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as api from "../../api/aug";

export default function AugGraphList() {
  const [graphs, setGraphs] = useState<api.GraphSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
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

  const create = async () => {
    const clean = name.trim();
    if (!clean) return;
    try {
      const got = await api.createGraph(clean);
      navigate(`/augment/${got.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="mag-content">
      <div className="mag-pass-strip">
        <div className="mag-pass-id">
          <h1 className="mag-h1">Аугментации</h1>
          <p>
            Граф — это рецепт: он говорит, что сделать с кадрами и во сколько
            раз их станет больше. Кадры он берёт внутри проекта, а живёт здесь,
            у вас, и подключается к любому проекту ссылкой.
          </p>
        </div>
        <button
          className="mag-btn mag-pass-export"
          type="button"
          onClick={() => setMaking(true)}
        >
          Новый граф
        </button>
      </div>

      {error && <div className="mag-error">{error}</div>}

      {making && (
        <div className="mag-inline-form">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="Например: Ночная съёмка"
            aria-label="Имя графа"
          />
          <button className="mag-btn" type="button" onClick={create}>
            Создать
          </button>
          <button
            className="mag-ghost"
            type="button"
            onClick={() => setMaking(false)}
          >
            Отмена
          </button>
        </div>
      )}

      {graphs.length === 0 && !making ? (
        <div className="mag-empty-big">
          <b>Графов пока нет.</b>
          <p>
            Первый можно собрать за минуту: источник, пара аугментаций и выход.
            Числа на проводах покажут, во что превратятся кадры, ещё до запуска.
          </p>
          <button className="mag-btn" type="button" onClick={() => setMaking(true)}>
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
