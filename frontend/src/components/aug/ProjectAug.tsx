// «Аугментации» проекта: графы, подключённые ссылкой, — их предлагает мастер набора.
//
// Ссылкой, а не копией: удачный граф переносят из проекта в проект, и копия
// разошлась бы с оригиналом на первой же правке. Правит граф только владелец.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as api from "../../api/aug";
import { useAuth } from "../auth/AuthGate";
import { Button, Card, Empty, Input, LinkButton, MenuItem, Notice, PageHeader, Popover } from "../../ui";
import { count } from "../ru";
import { mult } from "./counts";
import GraphTable from "./GraphTable";
import { freeName } from "./look";

export default function ProjectAug() {
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { me } = useAuth();
  const [linked, setLinked] = useState<api.GraphSummary[] | null>(null);
  const [mine, setMine] = useState<api.GraphSummary[]>([]);
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Идёт запрос: двойной щелчок по «Подключить» слал два подряд.
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
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
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (call: () => Promise<unknown>) => {
    if (working) return;
    setWorking(true);
    try {
      await call();
    } catch (e) {
      setError((e as Error).message);
    }
    await refresh();
    setWorking(false);
  };

  const back = `/projects/${code}/aug`;
  const open = (id: string) => navigate(`/augment/${id}`, { state: { back } });

  /** Новый граф — в библиотеку, сразу в проект и на холст. */
  const create = async () => {
    if (working) return;
    setWorking(true);
    try {
      const taken = (await api.listGraphs("aug")).graphs.map((g) => g.name);
      const got = await api.createGraph(freeName(taken));
      await api.linkGraph(code, got.id);
      open(got.id);
    } catch (e) {
      setError((e as Error).message);
      setWorking(false);
    }
  };

  const canEdit = role === "admin" || role === "editor";
  const all = linked ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((g) => g.name.toLowerCase().includes(needle)) : all;
  }, [all, q]);
  const desc = linked === null ? "Загружаю…" : all.length === 0 ? "Графы, по которым мастер набора размножает кадры"
    : `${count(all.length, "граф подключён", "графа подключено", "графов подключено")} · их предлагает мастер набора`;

  const attach = canEdit && (
    <Popover align="end" width={320} trigger={<Button icon="plus" disabled={working}>Подключить граф</Button>}>
      {(close) => (<>
        <div className="ui-pop-h">Мои графы</div>
        {mine.length === 0 ? <p className="t-xs t-faint" style={{ padding: "4px 10px 8px" }}>Все ваши графы уже здесь</p> : (
          <div className="gl-pick">
            {mine.map((g) => (
              <MenuItem key={g.id} icon="workflow" disabled={working}
                hint={[g.version ? `v${g.version}` : "только черновик", g.stats ? mult(g.stats.multiplier) : ""].filter(Boolean).join(" · ")}
                onSelect={() => { close(); void act(() => api.linkGraph(code, g.id)); }}>{g.name}</MenuItem>
            ))}
          </div>
        )}
        <div className="ui-pop-sep" />
        <MenuItem icon="plus" onSelect={() => { close(); void create(); }} hint="В вашу библиотеку и сразу сюда">Новый граф</MenuItem>
      </>)}
    </Popover>
  );

  return (
    <div className="page">
      <PageHeader title="Аугментации" desc={desc} actions={<>
        {all.length > 0 && <Input icon="search" className="gl-q" placeholder="Найти граф" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Найти граф" />}
        <LinkButton variant="ghost" icon="workflow" to="/augment">Мои графы</LinkButton>
        {attach}
      </>} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      {linked !== null && all.length === 0 && (
        <div className="gl-empty">
          <b>К проекту не подключён ни один граф</b>
          <p>Граф живёт в библиотеке своего автора и подключается сюда ссылкой. Подключённые графы мастер набора
            предлагает для train и val; обучение на наборе с графом идёт без встроенных аугментаций ultralytics.</p>
          {canEdit && <div className="row">
            <Button variant="primary" icon="plus" disabled={working} onClick={create}>Новый граф</Button>
            {mine.length > 0 && attach}
          </div>}
        </div>
      )}

      {all.length > 0 && (
        <Card flush className="gl-card">
          {shown.length === 0 ? <Empty compact icon="search" title="Под поиск ничего не подошло" /> : (
            <GraphTable graphs={shown} owner onOpen={(g) => open(g.id)} menu={(g, close) => (<>
              <MenuItem icon="workflow" onSelect={() => { close(); open(g.id); }}
                hint={g.owner_id !== me.user.id ? "Только смотреть: править может владелец" : undefined}>Открыть</MenuItem>
              {canEdit && <MenuItem icon="x" danger disabled={working} onSelect={() => { close(); void act(() => api.unlinkGraph(code, g.id)); }}
                hint="Граф останется в библиотеке, собранные наборы — как были">Отключить от проекта</MenuItem>}
            </>)} />
          )}
        </Card>
      )}
    </div>
  );
}
