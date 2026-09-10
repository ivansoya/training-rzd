// Графы, подключённые к проекту.
//
// Ссылкой, а не копией: удачный граф переносят из проекта в проект, и копия
// разошлась бы с оригиналом на первой же правке. Править его можно только у
// себя в библиотеке — здесь он читается.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as api from "../../api/aug";
import Sep from "../Sep";

export default function ProjectAug() {
  const { code } = useParams<{ code: string }>();
  const [linked, setLinked] = useState<api.GraphSummary[]>([]);
  const [mine, setMine] = useState<api.GraphSummary[]>([]);
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!code) return;
    try {
      const got = await api.projectGraphs(code);
      setLinked(got.graphs);
      setMine(got.mine);
      setRole(got.role);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const canEdit = role === "admin" || role === "editor";

  return (
    <>
      {error && <div className="mag-error">{error}</div>}

      {linked.length === 0 ? (
        <div className="mag-empty-big">
          <b>К проекту не подключён ни один граф.</b>
          <p>
            Граф живёт в вашей библиотеке и подключается сюда ссылкой. Правки в
            нём увидят все проекты сразу, а собранные наборы — нет: они помнят
            ту версию, которой их собрали.
          </p>
          <Link to="/augment" className="mag-btn">
            Открыть библиотеку
          </Link>
        </div>
      ) : (
        <div className="g-graphs">
          {linked.map((g) => (
            <div key={g.id} className="g-graph-card">
              <span className="name">{g.name}</span>
              {g.description && <span className="desc">{g.description}</span>}
              <span className="foot">
                <span>версия {g.version}</span>
                {g.stats && <b>×{g.stats.multiplier}</b>}
                <span>{g.owner ?? "без владельца"}</span>
              </span>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <Link to={`/augment/${g.id}`} className="mag-ghost">
                  Открыть
                </Link>
                {canEdit && (
                  <button
                    type="button"
                    className="mag-ghost"
                    onClick={async () => {
                      if (!code) return;
                      await api
                        .unlinkGraph(code, g.id)
                        .catch((e) => setError((e as Error).message));
                      refresh();
                    }}
                  >
                    Отключить
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {canEdit && mine.length > 0 && (
        <>
          <div className="g-label" style={{ margin: "24px 0 10px" }}>
            Мои графы, не подключённые к проекту
          </div>
          <div className="t-rows">
            {mine.map((g) => (
              <div className="t-row" key={g.id}>
                <div>
                  <div className="name">{g.name}</div>
                  <div className="meta">
                    версия {g.version}
                    {g.stats ? ` — ×${g.stats.multiplier}` : ""} <Sep />{" "}
                    {g.stats?.nodes ?? 0} узлов
                  </div>
                </div>
                <div className="right">
                  <button
                    type="button"
                    className="mag-btn"
                    onClick={async () => {
                      if (!code) return;
                      await api
                        .linkGraph(code, g.id)
                        .catch((e) => setError((e as Error).message));
                      refresh();
                    }}
                  >
                    Подключить
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
