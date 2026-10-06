// «Мои агенты». Как и графы, живут вне проектов: агент принадлежит человеку и переносится
// из проекта в проект вместе со своими весами. Запускают его в таске — версией.

import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { useNavigate } from "react-router-dom";
import * as aug from "../../api/aug";
import { Button, Card, Empty, Input, MenuItem, Notice, PageHeader, Popover, Seg, Table } from "../../ui";
import { ago, count, ru } from "../ru";
import { useConfirm } from "../mag/tasks/Confirm";
import { statClasses } from "./agentDoc";
import { freeName } from "./look";

const CHIPS = 4;
const when = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }).replace(".", "");
type Stats = { classes?: unknown; nets?: number; nodes?: number } | null;

export default function AgentList() {
  // null — список ещё не пришёл: «Агентов пока нет» не мигает тому, у кого их десяток.
  const [agents, setAgents] = useState<aug.GraphSummary[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [q, setQ] = useState("");
  const [confirm, confirmNode] = useConfirm();
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      setAgents((await aug.listGraphs("agent", archived)).graphs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [archived]);

  useEffect(() => {
    setAgents(null);
    void refresh();
  }, [refresh]);

  /** Завести агента и сразу открыть: имя правится в шапке редактора. */
  const create = async () => {
    if (making) return;
    setMaking(true);
    setError(null);
    try {
      // Имя держат только живые агенты — и из архива смотрим на них же.
      const taken = (await aug.listGraphs("agent")).graphs.map((g) => g.name);
      const got = await aug.createGraph(freeName(taken), undefined, "agent");
      navigate(`/agents/${got.id}`);
    } catch (e) {
      setError((e as Error).message);
      setMaking(false);
    }
  };

  /** С рамками в проектах сервер откажет и скажет почему. */
  const remove = async (g: aug.GraphSummary) => {
    const ok = await confirm({
      title: `Удалить агента «${g.name}»?`, danger: true, icon: "trash", ok: "Удалить",
      desc: g.runs ? "Он уже ставил рамки в тасках — сервер может не дать удалить. Тогда уберите его в архив." : "Со всеми версиями. Вернуть не получится.",
    });
    if (!ok) return;
    try {
      await aug.deleteGraph(g.id);
      setAgents((old) => (old ?? []).filter((x) => x.id !== g.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Архивного агента не предлагают в окне запуска; рамки, что он поставил, остаются. */
  const shelve = async (g: aug.GraphSummary, away: boolean) => {
    if (away) {
      const ok = await confirm({
        title: `Убрать агента «${g.name}» в архив?`, icon: "archive", ok: "В архив",
        desc: "Его перестанут предлагать при запуске в тасках. Поставленные рамки останутся как были.",
      });
      if (!ok) return;
    }
    try {
      await aug.patchGraph(g.id, { archived: away });
      setAgents((old) => (old ?? []).filter((x) => x.id !== g.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const all = agents ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((g) => `${g.name} ${statClasses((g.stats as Stats)?.classes).map((c) => c.name).join(" ")}`.toLowerCase().includes(needle));
  }, [all, q]);
  const used = all.filter((g) => (g.runs ?? 0) > 0).length;
  const desc = agents === null ? "Загружаю…"
    : [count(all.length, "агент", "агента", "агентов"), used ? `${used} уже размечали` : ""].filter(Boolean).join(" · ");
  const stop = (e: SyntheticEvent) => e.stopPropagation();

  return (
    <div className="page">
      <PageHeader title="Мои агенты" desc={desc} actions={<>
        <Seg<"live" | "arch"> label="Какие агенты" value={archived ? "arch" : "live"} onChange={(v) => setArchived(v === "arch")}
          options={[{ value: "live", label: "Действующие" }, { value: "arch", label: "Архив", icon: "archive" }]} />
        {all.length > 0 && <Input icon="search" className="gl-q" placeholder="Найти агента или класс" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Найти агента" />}
        {!archived && <Button variant="primary" icon="plus" disabled={making} onClick={create}>Новый агент</Button>}
      </>} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      {agents !== null && all.length === 0 && (archived ? <Empty icon="archive" title="В архиве пусто" /> : (
        <div className="gl-empty">
          <b>Агентов пока нет</b>
          <p>Агент разметки — схема «кадр → сети → обработка рамок → выход»: сеть на своих весах или по тексту, NMS, фильтр, уточнение SAM.
            Он живёт в вашей библиотеке и запускается в любой таске, где вы исполнитель или администратор. Веса берутся из обучений или с диска.</p>
          <Button variant="primary" icon="plus" disabled={making} onClick={create}>Собрать первого агента</Button>
        </div>
      ))}

      {all.length > 0 && (
        <Card flush className="gl-card">
          {shown.length === 0 ? <Empty compact icon="search" title="Под поиск ничего не подошло" /> : (
            <Table className="gl-tbl">
              <thead>
                <tr>
                  <th>Агент</th><th>Версия</th><th>Классы</th><th className="r">Сетей</th><th className="r">Запусков</th>
                  <th className="r">Рамок</th><th>Последний запуск</th><th>Создан</th><th />
                </tr>
              </thead>
              <tbody>
                {shown.map((g) => {
                  const st = g.stats as Stats;
                  const classes = statClasses(st?.classes);
                  const open = () => navigate(`/agents/${g.id}`);
                  return (
                    <tr key={g.id} className="gl-row" tabIndex={0} aria-label={`Агент ${g.name}`} onClick={open}
                      onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
                      <td className="gl-name">
                        <b>{g.name}</b>
                        {g.description && <p>{g.description}</p>}
                      </td>
                      <td>{g.version ? <span className="ui-mono">v{g.version}</span> : <span className="t-xs t-faint">только черновик</span>}</td>
                      <td>
                        {classes.length === 0 ? <span className="t-faint">—</span> : (
                          <span className="al-cls" title={classes.map((c) => c.name).join(", ")}>
                            {classes.slice(0, CHIPS).map((c) => (
                              <span key={c.id ?? c.name} className="al-chip"><i style={{ background: c.color }} />{c.name}</span>
                            ))}
                            {classes.length > CHIPS && <span className="t-xs t-muted">ещё {classes.length - CHIPS}</span>}
                          </span>
                        )}
                      </td>
                      <td className="r ui-mono">{st?.nets ?? <span className="t-faint">—</span>}</td>
                      <td className="r ui-mono">{g.runs ? ru(g.runs) : <span className="t-faint">—</span>}</td>
                      <td className="r ui-mono">{g.boxes ? ru(g.boxes) : <span className="t-faint">—</span>}</td>
                      <td className="gl-when">{g.last_run_at ? ago(g.last_run_at) : <span className="t-faint">не запускали</span>}</td>
                      <td className="gl-when">{when(g.created_at)}</td>
                      <td className="r gl-act" onClick={stop} onKeyDown={stop}>
                        <Popover align="end" width={280} trigger={<Button size="sm" variant="ghost" icon="more" aria-label={`Действия с агентом ${g.name}`} />}>
                          {(close) => (<>
                            <MenuItem icon="workflow" onSelect={() => { close(); open(); }}>Открыть</MenuItem>
                            <MenuItem icon="archive" onSelect={() => { close(); void shelve(g, !archived); }}
                              hint={archived ? "Снова предлагать при запуске" : "Рамки останутся"}>{archived ? "Вернуть из архива" : "В архив…"}</MenuItem>
                            <MenuItem icon="trash" danger onSelect={() => { close(); void remove(g); }}
                              hint={g.runs ? "Уже ставил рамки" : "Со всеми версиями"}>Удалить…</MenuItem>
                          </>)}
                        </Popover>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      {confirmNode}
    </div>
  );
}
