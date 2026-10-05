// «Мои графы»: личная библиотека. Живёт вне проектов: удачный граф переносят из
// проекта в проект, и копия разошлась бы с оригиналом на первой же правке.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../../api/aug";
import { Button, Card, Empty, Input, MenuItem, Notice, PageHeader, Seg } from "../../ui";
import { count } from "../ru";
import { useConfirm } from "../mag/tasks/Confirm";
import GraphTable from "./GraphTable";
import { freeName } from "./look";

export default function AugGraphList() {
  // null — список ещё не пришёл: «Графов пока нет» не мигает тому, у кого их десяток.
  const [graphs, setGraphs] = useState<api.GraphSummary[] | null>(null);
  // Архив — отдельный список: граф с наборами удалить нельзя, но убрать с глаз можно.
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [q, setQ] = useState("");
  const [confirm, confirmNode] = useConfirm();
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
    void refresh();
  }, [refresh]);

  /** Завести граф и сразу открыть: имя придумывают уже на холсте, глядя на собранное. */
  const create = async () => {
    if (making) return;
    setMaking(true);
    setError(null);
    try {
      // Имя держат только живые графы — и из архива смотрим на них же.
      const taken = (await api.listGraphs("aug")).graphs.map((g) => g.name);
      const got = await api.createGraph(freeName(taken));
      navigate(`/augment/${got.id}`);
    } catch (e) {
      setError((e as Error).message);
      setMaking(false);
    }
  };

  /** Граф, по которому собран набор, сервер не удалит (409) — причину он пишет сам. */
  const remove = async (g: api.GraphSummary) => {
    const ok = await confirm({
      title: `Удалить граф «${g.name}»?`, danger: true, icon: "trash", ok: "Удалить",
      desc: g.used_by_sets ? "По нему собраны наборы — сервер не даст удалить. Уберите его в архив." : "Со всеми версиями. Вернуть не получится.",
    });
    if (!ok) return;
    try {
      await api.deleteGraph(g.id);
      setGraphs((old) => (old ?? []).filter((x) => x.id !== g.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Архивный граф не предлагается ни в проекте, ни в мастере набора; наборы по нему остаются. */
  const shelve = async (g: api.GraphSummary, away: boolean) => {
    if (away) {
      const ok = await confirm({
        title: `Убрать граф «${g.name}» в архив?`, icon: "archive", ok: "В архив",
        desc: "Его перестанут предлагать в проектах и мастере набора. Собранные наборы останутся как были.",
      });
      if (!ok) return;
    }
    try {
      await api.patchGraph(g.id, { archived: away });
      setGraphs((old) => (old ?? []).filter((x) => x.id !== g.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const all = graphs ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((g) => g.name.toLowerCase().includes(needle)) : all;
  }, [all, q]);
  const inSets = all.filter((g) => g.used_by_sets > 0).length;
  const desc = graphs === null ? "Загружаю…"
    : [count(all.length, "граф", "графа", "графов"), inSets ? `${inSets} в наборах` : ""].filter(Boolean).join(" · ");

  return (
    <div className="page">
      <PageHeader title="Мои графы" desc={desc} actions={<>
        <Seg<"live" | "arch"> label="Какие графы" value={archived ? "arch" : "live"} onChange={(v) => setArchived(v === "arch")}
          options={[{ value: "live", label: "Действующие" }, { value: "arch", label: "Архив", icon: "archive" }]} />
        {all.length > 0 && <Input icon="search" className="gl-q" placeholder="Найти граф" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Найти граф" />}
        {!archived && <Button variant="primary" icon="plus" disabled={making} onClick={create}>Новый граф</Button>}
      </>} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      {graphs !== null && all.length === 0 && (archived ? <Empty icon="archive" title="В архиве пусто" /> : (
        <div className="gl-empty">
          <b>Графов пока нет</b>
          <p>Граф аугментаций — схема, по которой кадры набора размножаются копиями: источник, пара преобразований и выход.
            Он живёт в вашей библиотеке, подключается к проектам ссылкой и выбирается в мастере набора.</p>
          <Button variant="primary" icon="plus" disabled={making} onClick={create}>Собрать первый граф</Button>
        </div>
      ))}

      {all.length > 0 && (
        <Card flush className="gl-card">
          {shown.length === 0 ? <Empty compact icon="search" title="Под поиск ничего не подошло" /> : (
            <GraphTable graphs={shown} onOpen={(g) => navigate(`/augment/${g.id}`)} menu={(g, close) => (<>
              <MenuItem icon="workflow" onSelect={() => { close(); navigate(`/augment/${g.id}`); }}>Открыть</MenuItem>
              <MenuItem icon="archive" onSelect={() => { close(); void shelve(g, !archived); }}
                hint={archived ? "Снова предлагать в проектах" : "Наборы по нему останутся"}>{archived ? "Вернуть из архива" : "В архив…"}</MenuItem>
              <MenuItem icon="trash" danger onSelect={() => { close(); void remove(g); }}
                hint={g.used_by_sets ? "По нему собраны наборы" : "Со всеми версиями"}>Удалить…</MenuItem>
            </>)} />
          )}
        </Card>
      )}
      {confirmNode}
    </div>
  );
}
