// Мои агенты разметки. Как и графы, живут вне проектов: агент принадлежит
// человеку и переносится из проекта в проект вместе со своими весами.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as aug from "../../api/aug";
import Banner from "../Banner";

export default function AgentList() {
  const [agents, setAgents] = useState<aug.GraphSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      setAgents((await aug.listGraphs("agent")).graphs);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Имя не спрашиваем — как у графов: правится в шапке редактора.
  const create = async () => {
    if (making) return;
    setMaking(true);
    const taken = new Set((agents ?? []).map((g) => g.name));
    let name = "Новый агент";
    for (let n = 2; taken.has(name); n++) name = `Новый агент ${n}`;
    try {
      const got = await aug.createGraph(name, undefined, "agent");
      navigate(`/agents/${got.id}`);
    } catch (e) {
      setError((e as Error).message);
      setMaking(false);
    }
  };

  const archive = async (g: aug.GraphSummary) => {
    try {
      await aug.patchGraph(g.id, { archived: true });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="mag-content">
      <div className="mag-pass-strip">
        <div className="mag-pass-id">
          <h1 className="mag-h1">Агенты разметки</h1>
        </div>
        <button className="mag-btn mag-pass-export" type="button" disabled={making} onClick={create}>
          Новый агент
        </button>
      </div>

      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

      {agents?.length === 0 ? (
        <div className="mag-empty-big">
          <b>Агентов пока нет.</b>
          <p>Кадр, сеть со своими весами и выход.</p>
          <button className="mag-btn" type="button" disabled={making} onClick={create}>
            Собрать первого агента
          </button>
        </div>
      ) : (
        <div className="g-graphs">
          {(agents ?? []).map((g) => {
            const classes = (g.stats as unknown as { classes?: string[] } | null)?.classes ?? [];
            return (
              <div key={g.id} className="g-graph-card">
                <Link to={`/agents/${g.id}`} className="name">{g.name}</Link>
                {classes.length > 0 && (
                  <span className="desc">{classes.slice(0, 6).join(", ")}{classes.length > 6 ? ` и ещё ${classes.length - 6}` : ""}</span>
                )}
                <span className="foot">
                  <span>{g.version ? `версия ${g.version}` : "без версии"}</span>
                  <span>{classes.length} кл.</span>
                  <button type="button" className="g-graph-del" onClick={() => archive(g)}>
                    В архив
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
