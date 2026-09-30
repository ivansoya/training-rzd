// Графы, подключённые к проекту.
//
// Ссылкой, а не копией: удачный граф переносят из проекта в проект, и копия
// разошлась бы с оригиналом на первой же правке. Править его можно только у
// себя в библиотеке — здесь он читается.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as api from "../../api/aug";
import { mult } from "./counts";
import { count } from "../ru";
import Sep from "../Sep";
import Banner from "../Banner";

export default function ProjectAug() {
  const { code } = useParams<{ code: string }>();
  const [linked, setLinked] = useState<api.GraphSummary[] | null>(null);
  const [mine, setMine] = useState<api.GraphSummary[]>([]);
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  // Граф, над которым идёт запрос. Двойной щелчок по «Подключить» слал два
  // запроса подряд; кнопка гаснет до ответа, сервер к тому же отвечает на
  // повтор тем же подключением.
  const [working, setWorking] = useState<string | null>(null);

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

  const act = async (id: string, call: () => Promise<unknown>) => {
    if (working) return;
    setWorking(id);
    try {
      await call();
    } catch (e) {
      setError((e as Error).message);
    }
    await refresh();
    setWorking(null);
  };

  const canEdit = role === "admin" || role === "editor";

  return (
    <>
      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

      {linked === null ? null : linked.length === 0 ? (
        <div className="mag-empty-big">
          <b>К проекту не подключён ни один граф.</b>
          <p>Граф живёт в вашей библиотеке и подключается сюда ссылкой.</p>
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
                {g.stats && <b>{mult(g.stats.multiplier)}</b>}
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
                    disabled={working !== null}
                    onClick={() => code && act(g.id, () => api.unlinkGraph(code, g.id))}
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
                    {g.stats ? ` — ${mult(g.stats.multiplier)}` : ""} <Sep />{" "}
                    {count(g.stats?.nodes ?? 0, "узел", "узла", "узлов")}
                  </div>
                </div>
                <div className="right">
                  <button
                    type="button"
                    className="mag-btn"
                    disabled={working !== null}
                    onClick={() => code && act(g.id, () => api.linkGraph(code, g.id))}
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
