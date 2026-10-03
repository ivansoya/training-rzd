// Мои агенты разметки. Как и графы, живут вне проектов: агент принадлежит
// человеку и переносится из проекта в проект вместе со своими весами.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as aug from "../../api/aug";
import Banner from "../Banner";
import { count } from "../ru";

export default function AgentList() {
  const [agents, setAgents] = useState<aug.GraphSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  // Архив — отдельным списком, как у графов: оттуда агента возвращают.
  const [archived, setArchived] = useState(false);
  // Карточка, на которой спрашиваем «В архив?». Сразу по щелчку агент
  // пропадал из списка, а вернуть его было неоткуда.
  const [asking, setAsking] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      setAgents((await aug.listGraphs("agent", archived)).graphs);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [archived]);

  useEffect(() => {
    setAgents(null);
    setAsking(null);
    refresh();
  }, [refresh]);

  // Имя не спрашиваем — как у графов: правится в шапке редактора.
  const create = async () => {
    if (making) return;
    setMaking(true);
    try {
      // Имя держат только живые агенты: из архива смотрим на них же.
      const taken = new Set((await aug.listGraphs("agent")).graphs.map((g) => g.name));
      let name = "Новый агент";
      for (let n = 2; taken.has(name); n++) name = `Новый агент ${n}`;
      const got = await aug.createGraph(name, undefined, "agent");
      navigate(`/agents/${got.id}`);
    } catch (e) {
      setError((e as Error).message);
      setMaking(false);
    }
  };

  /** Удалить агента из архива. С рамками в проектах сервер откажет и скажет почему. */
  const remove = async (g: aug.GraphSummary) => {
    if (!window.confirm(`Удалить агента «${g.name}» со всеми версиями?`)) return;
    setWorking(g.id);
    setError(null);
    try {
      await aug.deleteGraph(g.id);
      setAgents((old) => (old ?? []).filter((x) => x.id !== g.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };

  const shelve = async (g: aug.GraphSummary, away: boolean) => {
    setWorking(g.id);
    setError(null);
    try {
      await aug.patchGraph(g.id, { archived: away });
      setAsking(null);
      setAgents((old) => (old ?? []).filter((x) => x.id !== g.id));
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
          <h1 className="mag-h1">{archived ? "Агенты разметки — архив" : "Агенты разметки"}</h1>
        </div>
        <button className="mag-ghost mag-ghost-inline" type="button" aria-pressed={archived}
          onClick={() => setArchived((v) => !v)}>
          {archived ? "← Мои агенты" : "Архив"}
        </button>
        {!archived && (
          <button className="mag-btn mag-pass-export" type="button" disabled={making} onClick={create}>
            Новый агент
          </button>
        )}
      </div>

      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

      {agents?.length === 0 && archived ? (
        <div className="mag-empty-big">
          <b>В архиве пусто.</b>
        </div>
      ) : agents?.length === 0 ? (
        <div className="mag-empty-big">
          <b>Агентов пока нет.</b>
          <p>Кадр, сеть со своими весами и выход. Веса берутся из прогонов
            обучения проекта — сперва обучите модель во вкладке «Обучение».</p>
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
                  <span>{count(classes.length, "класс", "класса", "классов")}</span>
                  {archived ? (
                    <>
                      <button type="button" className="g-graph-del" disabled={working === g.id} onClick={() => shelve(g, false)}>
                        Вернуть
                      </button>
                      <button type="button" className="g-graph-del" disabled={working === g.id} onClick={() => remove(g)}>
                        Удалить
                      </button>
                    </>
                  ) : asking === g.id ? (
                    <>
                      <span className="ag-warn-text ag-ask">В архив?</span>
                      <button type="button" className="g-graph-del" disabled={working === g.id} autoFocus
                        onClick={() => shelve(g, true)}>
                        Да
                      </button>
                      <button type="button" className="g-graph-del" onClick={() => setAsking(null)}>
                        Нет
                      </button>
                    </>
                  ) : (
                    <button type="button" className="g-graph-del" onClick={() => setAsking(g.id)}>
                      В архив
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
