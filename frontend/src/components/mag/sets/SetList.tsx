// «Наборы»: таблица наборов проекта — деление, образцы, место, лучшее обучение; щелчок по строке — страница набора.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode, SyntheticEvent } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import * as runsApi from "../../../api/runs";
import type { Run } from "../../../api/runs";
import * as setsApi from "../../../api/trainsets";
import type { TrainSet } from "../../../api/trainsets";
import { useLive } from "../../../live/LiveProvider";
import {
  Badge, Button, Card, Chip, Empty, Icon, Input, LinkButton, MenuItem, Notice, PageHeader, Popover, Progress, StackBar, Table,
} from "../../../ui";
import { count, ru } from "../../ru";
import RunDialog from "../runs/RunDialog";
import { dec } from "../runs/runs";
import { useConfirm } from "../tasks/Confirm";
import { BUSY, SET_STATUS, SPLIT_MODE, TRAIN, VAL, bytes, graphsOf, multiplier, runsBySet } from "./sets";
import type { SetRuns } from "./sets";

/** «3 окт, 14:54». */
export const when = (iso: string) => new Date(iso)
  .toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  .replace(".", "");

export default function SetList() {
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [sets, setSets] = useState<TrainSet[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [training, setTraining] = useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const got = await setsApi.listSets(code);
      setSets(got.sets);
      setRole(got.role);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    // Обучения — ради лучшего mAP50; без них список всё равно полезен
    runsApi.listRuns(code).then((got) => setRuns(got.runs)).catch(() => undefined);
  }, [code]);
  useEffect(() => { void refresh(); }, [refresh]);
  useLive("*", (e) => { if (["prep", "run", "*"].includes(e.k)) void refresh(); });

  // Пока что-то собирается, список обновляется сам и без живой связи
  const busy = (sets ?? []).some((s) => BUSY.includes(s.status));
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(t);
  }, [busy, refresh]);

  const canEdit = role === "admin" || role === "editor";
  const all = sets ?? [];
  const bySet = useMemo(() => runsBySet(runs), [runs]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((s) => s.name.toLowerCase().includes(needle)) : all;
  }, [all, q]);
  const building = all.find((s) => s.status === "building");

  const remove = async (s: TrainSet) => {
    const n = bySet.get(s.id)?.runs.length ?? 0;
    const ok = await confirm({
      title: `Удалить набор «${s.name}»?`, danger: true, icon: "trash", ok: "Удалить",
      desc: n ? `Файлы уйдут с диска. ${count(n, "обучение", "обучения", "обучений")} на нём останутся — с весами и метриками.`
        : "Файлы уйдут с диска.",
    });
    if (!ok) return;
    try { await setsApi.deleteSet(code, s.id); } catch (e) { setError((e as Error).message); }
    await refresh();
  };

  const nReady = all.filter((s) => s.status === "ready").length;
  const nBuild = all.filter((s) => s.status === "building").length;
  const nQueue = all.filter((s) => s.status === "queued").length;
  const disk = all.reduce((a, s) => a + s.size_bytes, 0);
  const desc = sets === null ? "Загружаю…" : all.length === 0 ? "Обучение идёт только из набора" : [
    count(all.length, "набор", "набора", "наборов"),
    nReady ? `${nReady} ${nReady === 1 ? "готов" : "готовы"}` : "",
    nBuild ? `${nBuild} собирается` : "",
    nQueue ? `${nQueue} в очереди` : "",
    disk ? `на диске ${bytes(disk)}` : "",
  ].filter(Boolean).join(" · ");

  // Старая вкладка «Обучения» жила здесь же
  if (search.get("tab") === "runs") return <Navigate replace to={`/projects/${code}/runs`} />;

  const newSet = canEdit && <LinkButton variant="primary" icon="plus" to={`/projects/${code}/training/new`}>Собрать набор</LinkButton>;

  return (
    <div className="page ts">
      <PageHeader title="Наборы" desc={desc} actions={all.length > 0 && <>
        <Input icon="search" className="ts-q" placeholder="Найти набор" value={q} onChange={(e) => setQ(e.target.value)}
          aria-label="Найти набор" />
        {newSet}
      </>} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      {sets !== null && all.length === 0 && <SetsEmpty action={newSet} />}

      {all.length > 0 && (
        <Card flush className="ts-card">
          {shown.length === 0 ? <Empty compact icon="search" title="Под поиск ничего не подошло" /> : (
            <Table className="ts-tbl">
              <thead>
                <tr>
                  <th>Набор</th><th>Состояние</th><th>Деление</th><th className="r">Образцов</th>
                  <th className="r">На диске</th><th>Лучший mAP50</th><th>Собран</th><th />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <SetRow key={s.id} set={s} runs={bySet.get(s.id)} canEdit={canEdit} building={building}
                    onOpen={() => navigate(`/projects/${code}/trainsets/${s.id}`)}
                    onTrain={() => setTraining(s.id)}
                    onSimilar={() => navigate(`/projects/${code}/training/new?from=${s.id}`)}
                    onRuns={() => navigate(`/projects/${code}/runs?set=${s.id}`)}
                    onDelete={() => void remove(s)} />
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {training && (
        <RunDialog code={code} seed={{ setId: training }} onClose={() => setTraining(null)}
          onStarted={(r) => { setTraining(null); navigate(`/projects/${code}/runs/${r.number}`); }} />
      )}
      {confirmNode}
    </div>
  );
}

function SetsEmpty({ action }: { action: ReactNode }) {
  const steps = [
    ["Данные", "Датасеты и классы. Кадры из открытых тасок в набор не идут."],
    ["Деление", "Случайно, с учётом классов или умное — по группам похожих кадров."],
    ["Аугментации", "Графы из «Аугментаций» на train; val обычно оставляют как есть."],
  ];
  return (
    <div className="ts-empty">
      <b>Наборов пока нет</b>
      <p>Набор — замороженный срез проекта для обучения: какие кадры и классы берём, как делим на train и val,
        через какие аугментации пропускаем. Он не меняется, поэтому обучение на нём можно повторить и через месяц.</p>
      <ol className="ts-ways">
        {steps.map(([t, d], i) => <li key={t}><span className="ui-mono">{i + 1}</span><b>{t}</b><span>{d}</span></li>)}
      </ol>
      {action}
    </div>
  );
}

/** Полоса train/val с числами под ней. */
export function SplitCell({ set }: { set: TrainSet }) {
  const c = set.counts;
  if (!c) return <span className="t-xs t-faint">{SPLIT_MODE[set.split_mode]}</span>;
  return (
    <div className="ts-split">
      <StackBar label={`train ${c.train}, val ${c.val}`} parts={[
        { value: c.train, color: TRAIN, label: "train" }, { value: c.val, color: VAL, label: "val" },
      ]} />
      <div className="ts-split-n"><span>{ru(c.train)} <em>train</em></span><span>{ru(c.val)} <em>val</em></span></div>
    </div>
  );
}

export function SetBadge({ set }: { set: TrainSet }) {
  const st = SET_STATUS[set.status];
  const job = set.job;
  const pct = set.status === "building" && job?.total ? ` · ${Math.floor((job.processed / job.total) * 100)} %` : "";
  return <Badge tone={st.tone} live={st.live} icon={set.status === "error" ? "alert" : set.status === "queued" ? "clock" : undefined}>
    {st.label}{pct}
  </Badge>;
}

export function WarnBadge({ n }: { n: number }) {
  if (!n) return null;
  return <Badge tone="var(--st-skip)" icon="alert" title={`${count(n, "предупреждение", "предупреждения", "предупреждений")} — на странице набора`}>{n}</Badge>;
}

export function BuildProgress({ set }: { set: TrainSet }) {
  const job = set.job;
  if (!job) return null;
  return (
    <div className="ts-prog">
      <span className="t-sm">{job.stage_text ?? "Готовлю"}{job.total ? <> · <span className="ui-mono">{ru(job.processed)}</span> из <span className="ui-mono">{ru(job.total)}</span></> : null}</span>
      <Progress value={job.total ? job.processed : 0} max={job.total || 1} label="Ход сборки" color={TRAIN} />
    </div>
  );
}

function SetRow({ set: s, runs, canEdit, building, onOpen, onTrain, onSimilar, onRuns, onDelete }: {
  set: TrainSet; runs?: SetRuns; canEdit: boolean; building?: TrainSet;
  onOpen: () => void; onTrain: () => void; onSimilar: () => void; onRuns: () => void; onDelete: () => void;
}) {
  const c = s.counts;
  const graphs = graphsOf(s);
  const mult = multiplier(s);
  const sub = s.status === "building" || s.status === "deleting" ? <BuildProgress set={s} />
    : s.status === "error" ? (
      <div className="ts-err">
        <Icon name="alert" />
        <span>{s.error ?? "Сборка не удалась."}</span>
        {canEdit && <Button size="sm" icon="refresh" onClick={onSimilar}>Собрать заново</Button>}
      </div>
    ) : null;
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const open = s.status === "deleting" ? undefined : onOpen;
  return (
    <>
      <tr className={sub ? "ts-row has-sub" : "ts-row"} tabIndex={open ? 0 : undefined} onClick={open}
        onKeyDown={(e) => { if (e.key === "Enter") open?.(); }} aria-label={`Набор ${s.name}`}>
        <td className="ts-name">
          <b>{s.name}</b>
          <div className="ts-chips">
            {graphs.length ? graphs.map((g) => <Chip key={g.id + g.version} icon="workflow">{g.name} · v{g.version}</Chip>)
              : <span className="ts-none">без аугментаций</span>}
          </div>
        </td>
        <td>
          <div className="row" style={{ gap: 6 }}><SetBadge set={s} /><WarnBadge n={c?.warnings ?? 0} /></div>
          {s.status === "queued" && building && <div className="t-xs t-faint ts-under">после «{building.name}»</div>}
        </td>
        <td>
          <SplitCell set={s} />
          {c && <div className="t-xs t-faint ts-under">{SPLIT_MODE[s.split_mode]}{s.split_mode !== "manual" ? `, val ${Math.round(s.val_ratio * 100)} %` : ""}</div>}
        </td>
        <td className="r">
          {c ? <><span className="ui-mono ts-big">{ru(c.samples)}</span>{mult && <span className="ts-mult">{mult}</span>}
            <div className="t-xs t-faint ts-nw">из {count(c.source_images, "кадра", "кадров", "кадров")}</div></>
            : <span className="t-faint">—</span>}
        </td>
        <td className="r">
          {s.status === "ready" ? <><span className="ui-mono">{bytes(s.size_bytes)}</span>
            {s.hardlinked_bytes > 0 && <div className="t-xs t-faint">+ {bytes(s.hardlinked_bytes)} ссылками</div>}</>
            : <span className="t-faint">—</span>}
        </td>
        <td>
          {runs?.best ? (
            <span className="ts-best"><b className="ui-mono">{dec(runs.best.map50)}</b>
              <span>№{runs.best.number} · {count(runs.runs.length, "обучение", "обучения", "обучений")}</span></span>
          ) : runs?.runs.length ? <span className="t-xs t-faint">{count(runs.runs.length, "обучение", "обучения", "обучений")}, без итога</span>
            : <span className="t-xs t-faint">{s.status === "ready" ? "не учили" : "—"}</span>}
        </td>
        <td className="ts-when">
          {s.built_at ? when(s.built_at) : "—"}
          {s.author && <div className="t-faint">{s.author}</div>}
        </td>
        <td className="r ts-act" onClick={stop} onKeyDown={stop}>
          <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
            {canEdit && <Button size="sm" icon="play" disabled={s.status !== "ready"} onClick={onTrain}
              title={s.status === "ready" ? "Новое обучение на этом наборе" : "Учить можно только собранный набор"}>Учить</Button>}
            <SetMenu set={s} runs={runs?.runs.length ?? 0} canEdit={canEdit}
              onOpen={open} onSimilar={onSimilar} onRuns={onRuns} onDelete={onDelete} />
          </div>
        </td>
      </tr>
      {sub && <tr className="ts-sub"><td colSpan={8}>{sub}</td></tr>}
    </>
  );
}

export function SetMenu({ set: s, runs, canEdit, onOpen, onSimilar, onRuns, onDelete, size = "sm" }: {
  set: TrainSet; runs: number; canEdit: boolean;
  onOpen?: () => void; onSimilar: () => void; onRuns: () => void; onDelete: () => void; size?: "sm" | "md";
}) {
  const mayDelete = s.can_manage && s.status !== "deleting";
  if (!(onOpen && s.status === "ready") && !canEdit && !runs && !mayDelete) return null;
  return (
    <Popover align="end" width={300} trigger={<Button size={size === "sm" ? "sm" : undefined} variant="ghost" icon="more" aria-label="Действия с набором" />}>
      {(close) => (<>
        {onOpen && s.status === "ready" && <MenuItem icon="images" onSelect={() => { close(); onOpen(); }}
          hint="Что на самом деле легло в набор — с копиями">Образцы</MenuItem>}
        {canEdit && <MenuItem icon="copy" onSelect={() => { close(); onSimilar(); }}
          hint="Мастер с настройками этого набора: поменять одно и собрать новый">Собрать похожий…</MenuItem>}
        {runs > 0 && <MenuItem icon="activity" onSelect={() => { close(); onRuns(); }}
          hint={count(runs, "обучение", "обучения", "обучений")}>Обучения на наборе</MenuItem>}
        {mayDelete && <MenuItem icon="trash" danger onSelect={() => { close(); onDelete(); }}
          hint={runs ? "Файлы уйдут с диска. Обучения останутся — с весами и метриками." : "Файлы уйдут с диска."}>
          {BUSY.includes(s.status) ? "Отменить и удалить…" : s.status === "error" && s.error?.startsWith("Удалить не вышло") ? "Удалить снова…" : "Удалить набор…"}
        </MenuItem>}
      </>)}
    </Popover>
  );
}
