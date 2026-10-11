// «Агенты» проекта: подключённые агенты таблицей и журнал их прогонов по таскам.
//
// Агент личный и подключается ссылкой: правит владелец, остальные открывают на чтение
// или делают копию. Превью и G на кадре в журнал не пишутся — только прогоны тасок.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as api from "../../api/agents";
import * as aug from "../../api/aug";
import { useLive } from "../../live/LiveProvider";
import {
  Avatar, Badge, Button, Card, Dot, Empty, Icon, LinkButton, MenuItem, Meta, Notice, PageHeader, Popover, Progress, Select, Swatch, Table, cx,
} from "../../ui";
import { ago, count, ru } from "../ru";
import { useConfirm } from "../mag/tasks/Confirm";
import { clock, dayLabel, duration } from "../mag/runs/runs";
import { gb, short, verdictDetail, verdictLook } from "./GpuVerdict";
import { cardList } from "../shell/useGpuState";

const MODE: Record<api.RunMode, string> = { frames: "кадры", annotate: "ролик", scout: "разведка" };
const STATUS: Record<api.RunView["status"], { word: string; tone: string; live?: boolean }> = {
  queued: { word: "в очереди", tone: "var(--faint)" },
  waiting_gpu: { word: "ждёт карту", tone: "var(--st-skip)" },
  running: { word: "идёт", tone: "var(--agent)", live: true },
  done: { word: "готово", tone: "var(--st-done)" },
  error: { word: "ошибка", tone: "var(--destructive)" },
  stopped: { word: "остановлен", tone: "var(--faint)" },
};
const ALL = "all";
const FILTER_STATUS = [
  { value: ALL, label: "" },
  { value: "active", label: "идут и ждут" },
  { value: "done", label: "готово" },
  { value: "error", label: "ошибка" },
  { value: "stopped", label: "остановлен" },
];
const COLS = 12;

const when = (iso: string) => `${dayLabel(iso).toLowerCase()} ${clock(iso)}`;
const num = (mb: number | null | undefined) => (mb ? gb(mb) : "—");
const stop = (e: SyntheticEvent) => e.stopPropagation();

export default function ProjectAgents() {
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<api.ProjectAgents | null>(null);
  const [mine, setMine] = useState<aug.GraphSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ id: string; name: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [confirm, confirmNode] = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const [got, own] = await Promise.all([api.projectAgents(code), aug.listGraphs("agent")]);
      setData(got);
      setMine(own.graphs);
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

  const agents = data?.agents ?? [];
  const linked = new Set(agents.map((a) => a.id));
  const free = mine.filter((g) => !linked.has(g.id) && !g.archived);
  const runs = agents.reduce((s, a) => s + a.runs, 0);
  const open = (a: api.ProjectAgent) => navigate(`/agents/${a.id}`, { state: { back: `/projects/${code}/agents` } });

  const unlink = async (a: api.ProjectAgent) => {
    const ok = await confirm({
      title: `Отключить «${a.name}» от проекта?`, icon: "x", ok: "Отключить",
      desc: "Его перестанут предлагать при запуске в тасках. Рамки, что он поставил, и журнал останутся.",
    });
    if (ok) await act(() => api.unlinkAgent(code, a.id));
  };
  const copy = (a: api.ProjectAgent) => act(async () => setCopied(await api.copyAgent(a.id)));

  const attach = data?.can_link && (
    <Popover align="end" width={340} trigger={<Button variant="outline" icon="plus" disabled={working}>Подключить агента</Button>}>
      {(close) => (<>
        <div className="ui-pop-h">Мои агенты</div>
        {free.length === 0 ? <p className="t-xs t-faint" style={{ padding: "4px 10px 8px" }}>Все ваши агенты уже здесь</p> : (
          <div className="gl-pick">
            {free.map((g) => (
              <MenuItem key={g.id} icon="bot" disabled={working || !g.version}
                hint={g.version ? `v${g.version}` : "только черновик — сохраните версию"}
                onSelect={() => { close(); void act(() => api.linkAgent(code, g.id)); }}>{g.name}</MenuItem>
            ))}
          </div>
        )}
      </>)}
    </Popover>
  );

  const desc = data === null ? "Загружаю…" : agents.length === 0 ? "Агенты разметки, которых предлагают при запуске в тасках"
    : [count(agents.length, "агент подключён", "агента подключено", "агентов подключено"),
      runs ? count(runs, "запуск", "запуска", "запусков") : "ещё не запускали"].join(" · ");

  return (
    <div className="page pa">
      <PageHeader title="Агенты" desc={desc} actions={<>
        <LinkButton variant="ghost" icon="sparkle" to="/agents">Мои агенты</LinkButton>
        {attach}
      </>} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
      {copied && (
        <Notice tone="ok" onClose={() => setCopied(null)}
          action={<Button size="sm" onClick={() => navigate(`/agents/${copied.id}`)}>Открыть копию</Button>}>
          Копия «{copied.name}» — в ваших агентах, со своими весами и образцами. К проекту её подключают отдельно.
        </Notice>
      )}

      {data !== null && agents.length === 0 && (
        <div className="gl-empty">
          <b>К проекту не подключён ни один агент</b>
          <p>Агент живёт в библиотеке владельца и подключается сюда ссылкой: правит его владелец, остальные открывают
            на чтение или делают копию. Подключённых агентов предлагают при запуске в тасках всем, кто размечает.</p>
          {attach}
        </div>
      )}

      {agents.length > 0 && (
        <Card flush className="gl-card">
          <Table className="gl-tbl pa-agents">
            <thead>
              <tr>
                <th>Агент</th><th>Версия</th><th>Память</th><th className="r">Запусков</th><th className="r">Кадров в мин</th>
                <th className="r">Принято рамок</th><th className="r">G за неделю</th><th>Последний запуск</th><th />
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <AgentRow key={a.id} agent={a} cards={data!.cards} queued={data!.queued} canCopy={data!.can_copy}
                  canUnlink={a.mine || data!.can_unlink_any} working={working}
                  onOpen={() => open(a)} onCopy={() => void copy(a)} onUnlink={() => void unlink(a)} />
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {data !== null && <RunJournal code={code} onChange={refresh} many={data.cards.length > 1} />}
      {confirmNode}
    </div>
  );
}

function AgentRow({ agent: a, cards, queued, canCopy, canUnlink, working, onOpen, onCopy, onUnlink }: {
  agent: api.ProjectAgent; cards: api.GpuCard[]; queued: number; canCopy: boolean; canUnlink: boolean; working: boolean;
  onOpen: () => void; onCopy: () => void; onUnlink: () => void;
}) {
  const look = a.verdict ? verdictLook(a.verdict) : null;
  const detail = a.verdict && a.total_mb !== null
    ? verdictDetail({ verdict: a.verdict, cards, queued, heaviest: a.heaviest, total_mb: a.total_mb }) : "";
  const last = a.last_status ? STATUS[a.last_status] : null;
  return (
    <tr className="gl-row" tabIndex={0} aria-label={`Агент ${a.name}`} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <td className="gl-name">
        <b>{a.name}</b>
        {!a.owner_here && <Badge tone="var(--st-skip)" title="Агент работает дальше; править его может только владелец">владелец вне проекта</Badge>}
        <p>{[a.owner?.name ?? "владелец удалён", a.mine ? "ваш" : "только чтение", `${a.classes} кл.`].join(" · ")}</p>
      </td>
      <td>{a.version ? <span className="ui-mono">v{a.version}</span> : <span className="t-xs t-faint">без версии</span>}</td>
      <td>
        {look && a.total_mb !== null ? (
          <span className="pa-mem" style={{ color: look.color }} title={`${look.word}: ${detail}`}>
            <Icon name={look.icon} size={14} />{gb(a.total_mb)} ГБ<em>{look.word}</em>
          </span>
        ) : <span className="t-faint">—</span>}
      </td>
      <td className="r">{a.runs ? ru(a.runs) : <span className="t-faint">—</span>}</td>
      <td className="r">{a.speed !== null ? ru(a.speed) : <span className="t-faint">—</span>}</td>
      <td className="r">{a.boxes ? <span title={`${ru(a.accepted)} из ${ru(a.boxes)}`}>{Math.round((a.accepted / a.boxes) * 100)} %</span> : <span className="t-faint">—</span>}</td>
      <td className="r">{a.applies_week ? ru(a.applies_week) : <span className="t-faint">—</span>}</td>
      <td className="gl-when">{a.last_run_at ? `${ago(a.last_run_at)}${last ? ` · ${last.word}` : ""}` : <span className="t-faint">не запускали</span>}</td>
      <td className="r gl-act" onClick={stop} onKeyDown={stop}>
        <Popover align="end" width={280} trigger={<Button size="sm" variant="ghost" icon="more" aria-label={`Действия с агентом ${a.name}`} />}>
          {(close) => (<>
            <MenuItem icon={a.mine ? "workflow" : "eye"} onSelect={() => { close(); onOpen(); }}
              hint={a.mine ? undefined : "Только смотреть: править может владелец"}>Открыть</MenuItem>
            {canCopy && a.version && <MenuItem icon="copy" disabled={working} onSelect={() => { close(); onCopy(); }}
              hint="В ваши агенты, со своими весами и образцами">Сделать копию</MenuItem>}
            {canUnlink && <MenuItem icon="x" danger disabled={working} onSelect={() => { close(); onUnlink(); }}
              hint="Агент останется у владельца, рамки — как были">Отключить от проекта</MenuItem>}
          </>)}
        </Popover>
      </td>
    </tr>
  );
}

function RunJournal({ code, onChange, many }: { code: string; onChange: () => void; many: boolean }) {
  const [filter, setFilter] = useState<api.JournalFilter>({});
  const [page, setPage] = useState<api.Journal | null>(null);
  const [rows, setRows] = useState<api.JournalRun[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Как строка появилась: «land» — пришла живьём, «in» — подгружена «Показать ещё».
  const [arrived, setArrived] = useState<Map<string, "land" | "in">>(new Map());
  // Номер выборки: смена фильтра перерисовывает тело таблицы с проявлением.
  const [take, setTake] = useState(0);
  const seq = useRef(0);
  const shownIds = useRef(new Set<string>());
  useEffect(() => { shownIds.current = new Set(rows.map((r) => r.id)); }, [rows]);
  const setRowsSeen = (got: api.JournalRun[]) => mark(got.filter((r) => !shownIds.current.has(r.id)).map((r) => r.id), "land");
  const mark = (ids: string[], how: "land" | "in") => {
    if (!ids.length) return;
    setArrived((m) => new Map([...m, ...ids.map((id) => [id, how] as const)]));
    window.setTimeout(() => setArrived((m) => { const n = new Map(m); ids.forEach((id) => n.delete(id)); return n; }), 1600);
  };

  // Первая страница по фильтрам; дозагруженные ниже неё строки сохраняются.
  const load = useCallback(async (keep: boolean) => {
    const n = ++seq.current;
    try {
      const got = await api.agentRuns(code, filter);
      if (n !== seq.current) return;
      setPage((old) => (keep && old ? { ...got, more: old.more || got.more } : got));
      setRows((old) => {
        if (!keep || !got.runs.length) return got.runs;
        const edge = got.runs[got.runs.length - 1].created_at;
        return [...got.runs, ...old.filter((r) => r.created_at < edge)];
      });
      if (keep) setRowsSeen(got.runs);
      else setTake((t) => t + 1);
      setError(null);
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    }
  }, [code, filter]);
  useEffect(() => { void load(false); }, [load]);

  const more = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    try {
      const got = await api.agentRuns(code, filter, last.created_at);
      setRows((old) => [...old, ...got.runs.filter((r) => !old.some((o) => o.id === r.id))]);
      mark(got.runs.map((r) => r.id), "in");
      setPage((old) => (old ? { ...old, more: got.more } : got));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Ход кадров правится на месте; смена состояния — перечитать журнал и таблицу агентов.
  const timer = useRef(0);
  useLive("agent", (e) => {
    if (e.n !== undefined && e.s === undefined) {
      setRows((old) => old.map((r) => (r.id === e.id ? { ...r, processed: e.n!, status: "running" } : r)));
      return;
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void load(true); onChange(); }, 300);
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Подряд идущие запуски одного дня — одна группа, как в «Обучениях».
  const days = useMemo(() => {
    const out: { label: string; runs: api.JournalRun[] }[] = [];
    for (const r of rows) {
      const label = dayLabel(r.created_at);
      if (out.length && out[out.length - 1].label === label) out[out.length - 1].runs.push(r);
      else out.push({ label, runs: [r] });
    }
    return out;
  }, [rows]);

  const facets = page?.facets;
  const pick = (key: keyof api.JournalFilter, label: string, icon: Parameters<typeof Select>[0]["icon"], options: { value: string; label: string }[]) => (
    <Select label={label} icon={icon} value={filter[key] ?? ALL} onChange={(v) => setFilter((f) => ({ ...f, [key]: v === ALL ? undefined : v }))}
      options={options.map((o) => ({ ...o, label: o.value === ALL ? `${label}: все` : o.label }))} />
  );
  const facet = (list: api.Facet[] | undefined) => [{ value: ALL, label: "" }, ...(list ?? []).map((f) => ({ value: f.id, label: f.name }))];
  const t = page?.totals;
  const sum = t ? [count(t.all, "запуск", "запуска", "запусков"), t.running ? `идёт ${t.running}` : "", t.waiting ? `ждёт ${t.waiting}` : ""]
    .filter(Boolean).join(" · ") : "Загружаю…";

  return (
    <Card flush className="pa-j" title="Запуски на тасках" desc={`${sum} · превью и G на кадре сюда не пишутся`}>
      <div className="pa-bar">
        {pick("agent", "Агент", "bot", facet(facets?.agents))}
        {pick("status", "Статус", "activity", FILTER_STATUS)}
        {pick("task", "Таска", "check", facet(facets?.tasks))}
        {pick("user", "Кто", "user", facet(facets?.users))}
        <span className="grow" />
        <span className="t-xs t-muted">Сначала новые · обновляется само</span>
      </div>
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
      {page !== null && rows.length === 0 ? (
        <Empty compact icon="history" title={Object.values(filter).some(Boolean) ? "Под условия ничего не подошло" : "Агентов на тасках проекта ещё не запускали"} />
      ) : (
        <Table className="pa-runs">
          <colgroup>
            <col className="c-chev" /><col className="c-time" /><col /><col className="c-task" /><col className="c-mode" />
            <col className="c-who" /><col className="c-status" /><col className="c-card" /><col className="c-mem" /><col className="c-wait" />
            <col className="c-dur" /><col className="c-frames" />
          </colgroup>
          <thead>
            <tr>
              <th className="pa-chev-c" /><th>Время</th><th>Агент</th><th>Таска</th><th>Режим</th><th>Кто</th><th>Статус</th>
              <th>{many ? "Карты" : "Карта"}</th><th className="r" title="Сколько просил у карты / сколько занял на пике">Память, ГБ</th>
              <th className="r">Ожидание</th><th className="r">Длит.</th><th className="r">Кадров / рамок</th>
            </tr>
          </thead>
          <tbody key={take} className="pa-take">
            {days.map((d) => (
              <Fragment key={d.label + d.runs[0].id}>
                <tr className="pa-day"><td colSpan={COLS}>{d.label}</td></tr>
                {d.runs.map((r) => (
                  <Fragment key={r.id}>
                    <JournalRow run={r} many={many} open={open === r.id} arrived={arrived.get(r.id)}
                      onToggle={() => setOpen((o) => (o === r.id ? null : r.id))} />
                    <Reveal open={open === r.id}><JournalDetail run={r} many={many} /></Reveal>
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
        </Table>
      )}
      {page?.more && (
        <button type="button" className="rn-more pa-more" onClick={() => void more()}>
          Показать ещё · показано {ru(rows.length)}{t ? ` из ${ru(t.all)}` : ""}
        </button>
      )}
    </Card>
  );
}

/** Раскрытие строки журнала: высота с 0 до содержимого и обратно, потом под-строка уходит из DOM. */
function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Два кадра: сначала свёрнутое состояние должно отрисоваться, иначе переходу не с чего начаться.
      let b = 0;
      const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setShown(true)); });
      return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); };
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), 400);
    return () => window.clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return (
    <tr className="pa-xp">
      <td colSpan={COLS}>
        <div className={cx("pa-x-w", shown && "in")}><div className="pa-x-in">{children}</div></div>
      </td>
    </tr>
  );
}

function JournalRow({ run: r, many, open, arrived, onToggle }: {
  run: api.JournalRun; many: boolean; open: boolean; arrived?: "land" | "in"; onToggle: () => void;
}) {
  const st = STATUS[r.status];
  const why = r.status === "error" ? r.error : r.status === "waiting_gpu" || r.status === "queued" ? r.queue_reason : null;
  const over = r.peak_mb && r.want_mb && r.peak_mb > r.want_mb;
  return (
    <tr className={cx("gl-row", open && "on", arrived && `pa-${arrived}`)} tabIndex={0} aria-expanded={open} onClick={onToggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
      <td className="pa-chev-c"><Icon name="chevR" size={14} /></td>
      <td className="gl-when">{clock(r.created_at)}</td>
      <td><span className="pa-ag"><b>{r.agent ?? "удалён"}</b>{r.version && <span>v{r.version}</span>}</span></td>
      <td className="pa-ell">{r.task.name ?? "удалена"}</td>
      <td className="t-muted">{MODE[r.mode]}</td>
      <td>{r.user ? <span className="pa-who"><Avatar name={r.user} size={22} /><span className="pa-ell">{r.user}</span></span> : <span className="t-faint">—</span>}</td>
      <td className="pa-st">
        <span className="row">
          <Dot color={st.tone} live={st.live} />
          <span className={r.status === "error" ? "pa-bad" : undefined}>{st.word}</span>
          {r.status === "running" && r.total ? <span className="t-muted">{ru(r.processed)} из {ru(r.total)}</span> : null}
          {r.sequential && <span className="pa-seq" title="Сумма не влезала в карту: кадры шли пачками, модели — по узлам"><Icon name="layers" size={13} />поочерёдно</span>}
        </span>
        {r.status === "running" && r.total ? <Progress value={r.processed} max={r.total} label="Ход прогона" color="var(--agent)" /> : null}
        {why && <span className="pa-why">{why}</span>}
      </td>
      {/* Карт несколько — номера: поделённый агент на «2–3», а имена у карт сервера часто одинаковые. */}
      <td>{many ? (r.cards?.length ? cardList(r.cards) : <span className="t-faint">—</span>)
        : r.card ? short(r.card).replace(/^RTX\s+/i, "") : <span className="t-faint">—</span>}</td>
      <td className="r">{num(r.want_mb)} / <span className={over ? "pa-bad" : r.peak_mb ? undefined : "t-faint"}>{num(r.peak_mb)}</span></td>
      <td className="r">{r.waited_s ? duration(r.waited_s) : r.started_at ? "сразу" : "—"}</td>
      <td className="r">{r.seconds ? duration(r.seconds) : "—"}</td>
      <td className="r">{r.started_at ? `${ru(r.processed)} / ${ru(r.stats.boxes ?? 0)}` : "—"}</td>
    </tr>
  );
}

function JournalDetail({ run: r, many }: { run: api.JournalRun; many: boolean }) {
  const words = r.words ? Object.values(r.words) : [];
  const params = [
    ["Версия", r.version ? `v${r.version}` : "—"],
    ["Режим", MODE[r.mode]],
    r.mode === "frames" ? ["Блоки кадров", r.sources.length ? count(r.sources.length, "блок", "блока", "блоков") : "все новые"]
      : ["Ролики", count(r.videos.length, "ролик", "ролика", "роликов")],
    r.step ? ["Шаг", `каждый ${r.step}-й кадр`] : null,
    words.length ? ["Слов за проход", words.join(", ")] : null,
    ["Начат", r.started_at ? when(r.started_at) : "не начинался"],
    r.finished_at ? ["Закончен", when(r.finished_at)] : null,
  ].filter(Boolean) as [string, string][];
  const memory: [string, ReactNode][] = [
    ["Режим", r.sequential ? "поочерёдно — медленнее, сумма не влезала в карту" : "целиком"],
    many ? ["Карты", r.cards?.length ? `${cardList(r.cards)}${r.card ? ` · ${short(r.card)}` : ""}` : "—"]
      : ["Карта", r.card ? short(r.card) : "—"],
    ["Память", `просили ${num(r.want_mb)} ГБ · ${r.peak_mb ? `пик ${gb(r.peak_mb)} ГБ` : "пик не записан"}`],
    ["Ожидание", `${r.waited_s ? duration(r.waited_s) : "без ожидания"}${r.queue_reason ? ` — ${r.queue_reason}` : ""}`],
  ];
  if (r.error) memory.push(["Ошибка", <span className="pa-bad">{r.error}</span>]);
  return (
    <div className="pa-x">
      <section><h4>Запуск</h4><Meta items={params} /></section>
      <section>
        <h4>Сопоставление классов</h4>
        {r.mapping.length === 0 ? <p className="t-xs t-muted">Сопоставление не сохранилось</p> : (
          <Meta items={r.mapping.map((m) => [m.agent, m.to
            ? <span className="row"><Swatch color={m.to.color} />{m.to.name}</span>
            : <span className="t-faint">не сопоставлен — пропущено</span>])} />
        )}
        <p className="t-xs t-faint">Рамки других агентов не стирались: уступали только менее уверенные с IoU ≥ 0,5.</p>
      </section>
      <section><h4>Память и режим</h4><Meta items={memory} /></section>
    </div>
  );
}
