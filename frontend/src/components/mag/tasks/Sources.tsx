// Источники кадров таски карточками: изображения, ролики на нарезку, ролики на разметку, кадры из разметки.

import { useState } from "react";
import type { ReactNode } from "react";
import type { AgentClearScope, PendingObject, PendingVideo, TaskNumbers, TaskPerson, TaskVideoItem, VideoPrepare } from "../../../auth/api";
import type { Tag } from "../../../api/tags";
import { Badge, Button, Card, Icon, Legend, LinkButton, MenuItem, Popover, StackBar, Swatch, cx } from "../../../ui";
import { count, plural, ru } from "../../ru";
import type { RunMode, RunView } from "../../../api/agents";
import type { AgentToolState } from "../../editor/AgentTool";
import AgentMenu from "./AgentMenu";
import type { AgentAction, AgentClear } from "./AgentMenu";
import TagPicker from "../TagPicker";
import VideoStrip from "../VideoStrip";
import { fmtBytes, fmtStep, fmtTime, framesIn } from "../VideoCutModal";
import type { SourceBlock, SourceCounts } from "./tasks";
import { STATES, agentVideo, coverage, dayOf, stateParts } from "./tasks";
import { hereNames } from "../here";
import type { Here } from "../here";
import { look as lookOf } from "./useTaskBoard";
import type { Fresh, Look } from "./useTaskBoard";

type Add = "images" | "cut" | "annotate";

export function AddMenu({ onAdd }: { onAdd: (what: Add) => void }) {
  return (
    <Popover align="end" width={320} trigger={<Button icon="plus" iconEnd="chevD">Добавить</Button>}>
      {(close) => (
        <>
          <MenuItem icon="images" onSelect={() => { close(); onAdd("images"); }}
            hint="Можно сразу папкой. Перед отправкой спросим таги — откуда кадры.">Изображения…</MenuItem>
          <MenuItem icon="cut" onSelect={() => { close(); onAdd("cut"); }}
            hint="Выберете участки ролика — из них нарежутся кадры.">Видео на нарезку…</MenuItem>
          <MenuItem icon="film" onSelect={() => { close(); onAdd("annotate"); }}
            hint="Ролик размечают треками; кадры появятся, когда закроете разметку.">Видео на разметку…</MenuItem>
        </>
      )}
    </Popover>
  );
}

export function TaskEmpty({ editable, dataset, onAdd }: { editable: boolean; dataset: string | null; onAdd: (w: Add) => void }) {
  const ways: [Add, "images" | "cut" | "film", string, string][] = [
    ["images", "images", "Изображения", "Файлы или папка целиком. Перед отправкой спросим таги — потом их не восстановить."],
    ["cut", "cut", "Видео на нарезку", "Выберете участки и шаг — из них получатся отдельные кадры."],
    ["annotate", "film", "Видео на разметку", "Размечаете сам ролик треками. Кадры появятся, когда закроете разметку."],
  ];
  return (
    <div className="tp-empty">
      <b>В таске пока нет кадров</b>
      <p>Таска — пул кадров: размечаете здесь, а на «Готово» размеченное уходит в датасет{dataset ? ` «${dataset}»` : ""}.</p>
      {editable ? (
        <div className="tp-ways">
          {ways.map(([w, icon, title, hint]) => (
            <button key={w} type="button" className="tp-way" onClick={() => onAdd(w)}>
              <Icon name={icon} size={22} /><b>{title}</b><span>{hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Состояния кадров с числами — под полосой. */
export function StateLegend({ c }: { c: SourceCounts }) {
  const keys = (["annotated", "empty", "skipped", "new", "deleted"] as const).filter((k) => c[k] || k === "new");
  return (
    <Legend items={[
      ...keys.map((k) => {
        const s = STATES.find((x) => x.key === k)!;
        return { color: s.color, label: <><b className="ui-mono">{ru(c[k] || 0)}</b> {s.label.toLowerCase()}</> };
      }),
      ...((c.agent || 0) > 0 ? [{ color: "var(--agent)", label: <><b className="ui-mono">{ru(c.agent!)}</b> от агента</> }] : []),
    ]} />
  );
}

function Progress({ c, known, look }: { c: SourceCounts; known: boolean; look: Look }) {
  const left = (c.new || 0) + (c.skipped || 0);
  // Полоса и подпись состояний — той же высоты, пока числа в пути
  if (!known) {
    return (
      <div className={cx("tp-prog", look.loading && "ui-shim", !look.loading && "tp-wait")}>
        <div className="tp-prog-r"><i className="ui-sk" style={{ height: 8 }} /><span className="ui-sk pill" style={{ width: 70 }} /></div>
        <div className="tp-legend-sk"><span className="ui-sk pill" style={{ width: 90 }} /><span className="ui-sk pill" style={{ width: 70 }} /><span className="ui-sk pill" style={{ width: 80 }} /></div>
      </div>
    );
  }
  return (
    <div className={cx("tp-prog", look.stale && "tp-stale", look.loading && "ui-shim")}>
      <div className="tp-prog-r">
        <StackBar parts={stateParts(c)} height={8} />
        <span className="t-xs t-muted">{left ? `${ru(left)} в работе` : `всё пройдено`}</span>
      </div>
      <StateLegend c={c} />
    </div>
  );
}

/** Кадры с непроверенной разметкой агента: открыть их в редакторе по одному. */
function ReviewAgent({ n, onReview }: { n?: number; onReview?: () => void }) {
  if (!n || !onReview) return null;
  return (
    <Button variant="ghost" size="sm" icon="bot" className="is-agent" onClick={onReview}
      title="Кадры с непроверенной разметкой агента — пройти их в редакторе">
      Проверить <span className="ui-mono">{ru(n)}</span>
    </Button>
  );
}

/** Агент из меню блока: агент таски, запуск сразу и окно «Агент таски». */
export interface AgentHooks {
  tool: AgentToolState;
  /** Агент уже идёт по таске или страница занята. */
  busy: boolean;
  onSetup: () => void;
  start: (body: { mode: RunMode; sources?: string[]; videos?: string[]; step: number }) => void;
  /** Полное окно запуска, настроенное на блок. */
  dialog: (ask: { mode: RunMode; videos?: string[]; sources?: string[]; modes: RunMode[]; within?: string[] }) => void;
  /** «Очистить непроверенное агентов» — окно с числом от сервера, потом удаление. */
  clear: (scope: AgentClearScope) => void;
}

/** Пункт очистки; число кадров — где странице оно известно, точное спросит окно. */
const clearOf = (agent: AgentHooks, scope: AgentClearScope, frames?: number, off?: string | false): AgentClear => ({
  hint: frames ? count(frames, "кадр", "кадра", "кадров") : undefined, off, run: () => agent.clear(scope),
});

/** Кнопка «Агент» в шапке блока: окно запуска со всеми режимами этого блока. */
function AgentButton({ agent, ask }: { agent: AgentHooks; ask: Parameters<AgentHooks["dialog"]>[0] }) {
  return (
    <Button variant="ghost" size="sm" icon="bot" className="is-agent" disabled={agent.busy} onClick={() => agent.dialog(ask)}
      title={agent.busy ? "Агент уже идёт по этой таске" : "Разметить или разведать этот блок агентом — с выбором режима"}>
      Агент
    </Button>
  );
}

/** Разметке нужны сопоставленные классы, разведке — нет. */
const unmapped = (agent: AgentHooks) => agent.tool.agent && agent.tool.mapped === 0 && "классы не сопоставлены ⚙";

const framesAction = (agent: AgentHooks, source: string, fresh: number, label = "Разметить новые кадры"): AgentAction => ({
  label, icon: "bot", hint: `${ru(fresh)} ${plural(fresh, "новый", "новых", "новых")}`,
  off: unmapped(agent) || (fresh === 0 && "новых кадров нет"),
  run: (step) => agent.start({ mode: "frames", sources: [source], step }),
});

const scoutAction = (agent: AgentHooks, videos: TaskVideoItem[], label: string): AgentAction => ({
  label, icon: "scan", hint: "где что есть — в разметку не пишет",
  off: videos.length === 0 && "роликов нет",
  run: (step) => agent.start({ mode: "scout", videos: videos.map((v) => v.id), step }),
});

const annotateAction = (agent: AgentHooks, videos: TaskVideoItem[], label: string): AgentAction => ({
  label, icon: "bot", hint: "каждый N-й кадр, кроме работы человека",
  off: unmapped(agent) || (videos.length === 0 && "открытых роликов нет"),
  run: (step) => agent.start({ mode: "annotate", videos: videos.map((v) => v.id), step }),
});

/** Ход агента по блоку — прямо в карточке, а не только полосой под шапкой. */
export function AgentLine({ run }: { run?: RunView | null }) {
  if (!run) return null;
  const pct = run.total ? Math.min(100, Math.round((run.processed / run.total) * 100)) : null;
  const what = run.mode === "scout" ? "разведывает" : "размечает";
  return (
    <div className="tp-agent" role="status">
      <Icon name="bot" size={13} />
      <span className="t-xs">
        Агент «{run.agent ?? "агент"}» {run.status === "running" ? what : run.status === "queued" ? "в очереди" : "ждёт карту"}
        {pct !== null && <> · <span className="ui-mono">{pct} %</span></>}
        {" · "}<span className="ui-mono">{ru(run.processed)}{run.total ? ` из ${ru(run.total)}` : ""}</span>
      </span>
      {pct !== null && <i className="tp-agent-bar"><u style={{ width: `${pct}%` }} /></i>}
    </div>
  );
}

/** Изображения, загруженные файлами, и копии кадров датасета (решения 14.10.2026). */
export function FramesCard({ block, look, editable, run, agent, onAnnotate, onReview, code, fillable }: {
  block: SourceBlock;
  /** Как рисовать числа блока: заготовка, бледное из кеша, переливание в пути. */
  look: Look;
  editable: boolean;
  /** Идущий по этому блоку агент. */
  run?: RunView | null;
  agent: AgentHooks;
  onAnnotate: () => void;
  onReview?: () => void;
  /** У копий датасета: ссылки на датасеты и «Добрать из датасета». */
  code?: string;
  fillable?: boolean;
}) {
  const files = block.kind !== "cut";
  const copies = block.kind === "dataset";
  const c = block.counts;
  return (
    <Card className="tp-src"
      title={<><Icon name={copies ? "database" : files ? "images" : "eye"} />{block.title}<Badge variant="secondary">{ru(block.total)}</Badge></>}
      desc={block.counts.first_at ? `с ${dayOf(block.counts.first_at)}` : undefined}
      actions={<>
        {copies && fillable && code && (
          <LinkButton size="sm" variant="ghost" icon="plus" to={`/projects/${code}/datasets`}>Добрать из датасета</LinkButton>
        )}
        {editable && <ReviewAgent n={block.counts.agent} onReview={onReview} />}
        {editable && <AgentButton agent={agent} ask={{ mode: "frames", sources: [block.key], modes: ["frames"] }} />}
        {block.total > 0 && (
          <Button size="sm" icon={editable ? "edit" : "eye"} onClick={onAnnotate}>
            {!editable ? "Смотреть" : files ? "Размечать" : "Проверить"}
          </Button>
        )}
        {editable && (
          <AgentMenu tool={agent.tool} busy={agent.busy} onSetup={agent.onSetup} label={`Агент: ${block.title}`}
            actions={[framesAction(agent, block.key, block.counts.new || 0)]}
            clear={clearOf(agent, { sources: [block.key] }, block.counts.agent)} />
        )}
      </>}>
      <AgentLine run={run} />
      {copies && code && !!block.datasets?.length && (
        <div className="row wrap">
          {block.datasets.map((d) => (
            <LinkButton key={d.id} size="sm" variant="ghost" icon="database" to={`/projects/${code}/datasets?ds=${d.id}`}>
              {d.name}<span className="ui-mono t-faint"> · {ru(d.n)}</span>
            </LinkButton>
          ))}
        </div>
      )}
      <Progress c={block.counts} known={block.known} look={look} />
      {copies && block.known && (
        <span className="t-xs t-muted">
          При сдаче: на место <b className="ui-mono">{ru((c.annotated || 0) + (c.empty || 0))}</b>
          {" · "}уберём из датасета <b className="ui-mono">{ru(c.deleted || 0)}</b>
          {" · "}не тронем <b className="ui-mono">{ru((c.new || 0) + (c.skipped || 0))}</b>
        </span>
      )}
    </Card>
  );
}

export function PrepareLine({ prepare }: { prepare?: VideoPrepare }) {
  if (!prepare) return null;
  if (prepare.error) return <span className="tp-prep bad"><Icon name="alert" size={13} />не удалось: {prepare.error}</span>;
  if (!prepare.busy) return prepare.ready ? null : <span className="tp-prep"><i />готовится…</span>;
  const pct = prepare.total > 0 ? Math.min(100, Math.round((prepare.processed / prepare.total) * 100)) : null;
  return <span className="tp-prep"><i />{prepare.stage_text || "готовлю"}{pct !== null && ` · ${pct} %`}</span>;
}

export function Rail({ parts, tone }: { parts: [number, number][]; tone?: "track" }) {
  return (
    <span className={cx("tp-rail", tone)} aria-hidden="true">
      {parts.map(([a, b], i) => <u key={i} style={{ left: `${a * 100}%`, width: `${Math.max(0.6, (b - a) * 100)}%` }} />)}
    </span>
  );
}

/** Ролики на нарезку: общий счёт кадров и строка на каждый ролик со своим планом. */
export function CutCard({ block, look, taskId, code, tags, editable, fillable, run, agent, onAnnotate, onReview,
  onCut, onDelete, onVideoTags, onTagCreated }: {
  block: SourceBlock;
  look: Look;
  taskId: string;
  code: string;
  tags: Tag[];
  /** Работа над кадрами: агент, разметка. */
  editable: boolean;
  /** Источники: нарезка, таги роликов, удаление — на очереди тоже. */
  fillable: boolean;
  run?: RunView | null;
  agent: AgentHooks;
  onAnnotate: () => void;
  onReview: () => void;
  onCut: (v: TaskVideoItem) => void;
  onDelete: (v: TaskVideoItem) => void;
  onVideoTags: (v: TaskVideoItem, ids: string[]) => void;
  onTagCreated: (t: Tag) => void;
}) {
  const videos = block.videos || [];
  // Пересечение: чип «на все» обещает, что таг стоит у каждого ролика
  const common = videos.reduce<string[]>((acc, v) => acc.filter((id) => (v.tag_ids || []).includes(id)),
    [...(videos[0]?.tag_ids || [])]);
  const tagAll = (next: string[]) => {
    const added = next.filter((id) => !common.includes(id));
    const removed = common.filter((id) => !next.includes(id));
    for (const v of videos) {
      const own = v.tag_ids || [];
      const ids = [...new Set([...own, ...added])].filter((id) => !removed.includes(id));
      if (ids.length !== own.length || ids.some((id) => !own.includes(id))) onVideoTags(v, ids);
    }
  };
  return (
    <Card className="tp-src"
      title={<><Icon name="cut" />Ролики на нарезку<Badge variant="secondary">{videos.length}</Badge></>}
      desc={block.total ? `${count(block.total, "кадр нарезан", "кадра нарезано", "кадров нарезано")}` : "ещё ничего не нарезано"}
      actions={<>
        {editable && <ReviewAgent n={block.counts.agent} onReview={onReview} />}
        {editable && <AgentButton agent={agent} ask={{ mode: block.total ? "frames" : "scout", sources: [block.key],
          videos: videos.map((v) => v.id), within: videos.map((v) => v.id), modes: ["frames", "scout"] }} />}
        {block.total > 0 && (
          <Button size="sm" icon={editable ? "edit" : "eye"} onClick={onAnnotate}>{editable ? "Размечать нарезанное" : "Смотреть"}</Button>
        )}
        {editable && (
          <AgentMenu tool={agent.tool} busy={agent.busy} onSetup={agent.onSetup} label="Агент: ролики на нарезку" step
            actions={[framesAction(agent, block.key, block.counts.new || 0, "Разметить нарезанные кадры"),
              scoutAction(agent, videos, "Разведать все ролики")]}
            clear={clearOf(agent, { sources: [block.key] }, block.counts.agent)} />
        )}
      </>}>
      <AgentLine run={run} />
      {block.total > 0 && <Progress c={block.counts} known={block.known} look={look} />}
      {fillable && videos.length > 1 && (
        <div className="tp-tagall">
          <span className="t-xs t-muted">Таг на все {videos.length}</span>
          <TagPicker code={code} all={tags} value={common} compact placeholder="таг на все ролики"
            onChange={tagAll} onCreated={onTagCreated} />
        </div>
      )}
      <div className="tp-reels">
        {videos.map((v) => (
          <ReelRow key={v.id} v={v} taskId={taskId} code={code} tags={tags} editable={fillable}
            menu={(editable || fillable) && (
              <AgentMenu tool={agent.tool} busy={agent.busy} onSetup={agent.onSetup} label={`Ещё: ${v.file_name}`} step
                actions={editable ? [scoutAction(agent, [v], "Разведать ролик")] : []}
                clear={editable ? clearOf(agent, { sources: [v.id] }) : undefined}
                deleteLabel="Удалить ролик и его кадры" onDelete={fillable ? () => onDelete(v) : undefined} />
            )}
            onCut={() => onCut(v)}
            onTags={(ids) => onVideoTags(v, ids)} onTagCreated={onTagCreated} />
        ))}
      </div>
    </Card>
  );
}

function ReelRow({ v, taskId, code, tags, editable, menu, onCut, onTags, onTagCreated }: {
  v: TaskVideoItem;
  taskId: string;
  code: string;
  tags: Tag[];
  /** Нарезка и таги ролика — наполнение, а не работа над кадрами. */
  editable: boolean;
  /** Меню «⋯»: агент на ролик и удаление. */
  menu: ReactNode;
  onCut: () => void;
  onTags: (ids: string[]) => void;
  onTagCreated: (t: Tag) => void;
}) {
  const [open, setOpen] = useState(false);
  const segs = v.segments.length;
  return (
    <div className="tp-reel">
      <VideoStrip className="tp-poster" taskId={taskId} videoId={v.id} />
      <div className="tp-reel-n">
        <b className="t-ell" title={v.file_name}>{v.file_name}</b>
        <span className="t-xs t-muted">{fmtTime(v.duration_ms || 0)} · {v.width}×{v.height} · {fmtBytes(v.size_bytes)}</span>
        <Rail parts={coverage(v)} />
        <span className="tp-reel-s"><PrepareLine prepare={v.prepare} /></span>
      </div>
      <div className="tp-reel-c">
        <b className="ui-mono">{v.frames ? ru(v.frames) : "—"}</b>
        {segs ? (
          <button type="button" className="tp-segs" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
            {count(segs, "участок", "участка", "участков")}<Icon name="chevD" size={13} />
          </button>
        ) : <span className="t-xs t-faint">не нарезан</span>}
      </div>
      <div className="tp-reel-a">
        <Button size="sm" icon={editable ? "cut" : "eye"} onClick={onCut}>{!editable ? "Смотреть" : segs ? "Нарезать ещё" : "Нарезать"}</Button>
        {menu}
      </div>
      <div className="tp-reel-t">
        <TagPicker code={code} all={tags} value={v.tag_ids || []} disabled={!editable} compact placeholder="таг ролика"
          onChange={onTags} onCreated={onTagCreated} />
      </div>
      <div className={cx("tp-fold", open && "open")}>
        <div>
          <table className="tp-mini">
            <thead><tr><th>участок</th><th>с — по</th><th>длина</th><th>шаг</th><th className="r">кадров</th></tr></thead>
            <tbody>
              {v.segments.map((s, i) => (
                <tr key={i}>
                  <td>{s.end_ms - s.start_ms <= 1 ? "кадр" : i + 1}</td>
                  <td className="ui-mono">{fmtTime(s.start_ms)} — {fmtTime(s.end_ms)}</td>
                  <td className="ui-mono">{fmtTime(Math.max(0, s.end_ms - s.start_ms))}</td>
                  <td>{s.end_ms - s.start_ms <= 1 ? "—" : fmtStep(s.step_ms)}</td>
                  <td className="r ui-mono">{ru(framesIn(s))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

type TaskClass = TaskNumbers["classes"][number];

function classOf(classes: TaskClass[], o: PendingObject): { name: string; color: string | null } {
  if (o.class_name) return { name: o.class_name, color: o.class_color || null };
  const found = classes.find((c) => c.class_index === o.class_index);
  return found ? { name: found.name, color: found.color }
    : { name: o.class_index === null ? "класс не задан" : `класс ${o.class_index}`, color: null };
}

/** Ролики на разметку: каждый со своей шкалой, объектами и тем, что уйдёт при сдаче. */
export function AnnotateCard({ videos, working, handing, pending, fresh, at, classes, taskId, code, tags, editable, fillable, run, here, people, agent, onAdd,
  onOpen, onReview, onDelete, onVideoTags, onTagCreated }: {
  videos: TaskVideoItem[];
  /** Таска не сдана: разметка роликов ещё уйдёт при сдаче, и у них есть сводка. */
  working: boolean;
  /** Идёт сдача: кадры роликов уходят в датасет. */
  handing: boolean;
  /** Сводки роликов по мере прихода; нет ключа — ещё в пути, null — сдавать нечего. */
  pending: Record<string, PendingVideo | null>;
  fresh: Record<string, Fresh>;
  at: number | null;
  classes: TaskClass[];
  taskId: string;
  code: string;
  tags: Tag[];
  /** Работа над роликом: разметка, агент. */
  editable: boolean;
  /** Источники: добавить, удалить, таги ролика — на очереди тоже. */
  fillable: boolean;
  run?: RunView | null;
  /** Кто сейчас в редакторе какого ролика; имена — по участникам. */
  here: Here;
  people: TaskPerson[];
  agent: AgentHooks;
  onAdd: () => void;
  onOpen: (v: TaskVideoItem) => void;
  /** Открыть ролик на первом кадре с непроверенным агента. */
  onReview: (v: TaskVideoItem) => void;
  onDelete: (v: TaskVideoItem) => void;
  onVideoTags: (v: TaskVideoItem, ids: string[]) => void;
  onTagCreated: (t: Tag) => void;
}) {
  const unchecked = videos.reduce((s, v) => s + (pending[v.id]?.unchecked || 0), 0);
  const agentOn = agentVideo(run);
  return (
    <Card className="tp-src" flush
      title={<><Icon name="film" />Ролики на разметку<Badge variant="secondary">{videos.length}</Badge></>}
      desc="размечаются треками, кадрами датасета становятся при сдаче таски"
      actions={<>
        {editable && <AgentButton agent={agent} ask={{ mode: "annotate", videos: videos.map((v) => v.id),
          within: videos.map((v) => v.id), modes: ["annotate", "scout"] }} />}
        {fillable && <Button size="sm" icon="plus" onClick={onAdd}>Видео на разметку</Button>}
        {editable && <AgentMenu tool={agent.tool} busy={agent.busy} onSetup={agent.onSetup} label="Агент: ролики на разметку" step
          actions={[annotateAction(agent, videos, "Разметить все ролики"),
            scoutAction(agent, videos, "Разведать все ролики")]}
          clear={clearOf(agent, { videos: videos.map((v) => v.id) }, unchecked)} />}
      </>}>
      {run && <div className="tp-agent-w"><AgentLine run={run} /></div>}
      {videos.map((v) => {
        // У сданной таски сводки нет и не будет — ждать нечего
        const known = !working || v.id in pending;
        const p = pending[v.id] ?? undefined;
        const l = lookOf(known ? true : undefined, fresh[v.id], at);
        const zone = cx(l.stale && "tp-stale", l.loading && "ui-shim");
        const names = hereNames(here, v.id, people);
        const who = `${names.length > 1 ? "размечают" : "размечает"} ${names.join(", ")}`;
        return (
          <div key={v.id} className="tp-vid">
            <VideoStrip className="tp-poster big" taskId={taskId} videoId={v.id} />
            <div className="tp-vid-b">
              <div className="tp-vid-h">
                <b className="t-ell" title={v.file_name}>{v.file_name}</b>
                {handing ? <Badge tone="var(--c1)" live>сдаётся</Badge>
                  : !working ? <Badge tone="var(--st-done)" icon="tick">сдан</Badge>
                  : <>
                    {names.length > 0 && <span className="tp-here"><Badge tone="var(--c1)" live title={who}><span className="t-ell">{who}</span></Badge></span>}
                    {agentOn === v.id && <Badge tone="var(--agent)" live>агент {run?.mode === "scout" ? "разведывает" : "размечает"}</Badge>}
                  </>}
                <span className="grow" />
                {editable && !known && (
                  <Button variant="ghost" size="sm" icon="bot" className="is-agent" disabled>Проверить <span className="ui-sk pill" style={{ width: 34 }} /></Button>
                )}
                {editable && !!p?.unchecked && (
                  <Button variant="ghost" size="sm" icon="bot" className="is-agent" disabled={!v.prepare?.ready}
                    onClick={() => onReview(v)} title="Кадры ролика с непроверенной разметкой агента">
                    Проверить <span className="ui-mono">{ru(p.unchecked)}</span>
                  </Button>
                )}
                <Button size="sm" icon={editable ? "edit" : "eye"} disabled={!v.prepare?.ready}
                  title={v.prepare?.ready ? undefined : "Ролик ещё готовится"} onClick={() => onOpen(v)}>
                  {editable ? "Размечать ролик" : "Смотреть"}
                </Button>
                {(editable || fillable) && (
                  <AgentMenu tool={agent.tool} busy={agent.busy} onSetup={agent.onSetup} label={`Ещё: ${v.file_name}`} step
                    actions={editable ? [annotateAction(agent, [v], "Разметить ролик"), scoutAction(agent, [v], "Разведать ролик")] : []}
                    clear={editable ? clearOf(agent, { videos: [v.id] }, p?.unchecked) : undefined}
                    deleteLabel="Удалить ролик и его разметку" onDelete={fillable ? () => onDelete(v) : undefined} />
                )}
              </div>
              <span className="t-xs t-muted">
                {fmtTime(v.duration_ms || 0)} · {v.width}×{v.height} · {v.fps} к/с · {fmtBytes(v.size_bytes)}
                {" "}<PrepareLine prepare={v.prepare} />
              </span>
              {known ? <span className={zone}><Rail parts={coverage(v, p?.objects)} tone="track" /></span>
                : <i className={cx("ui-sk bar", l.loading && "ui-shim")} />}
              <div className="tp-vnums">
                {working && (
                  <span>{known ? <b className={zone}>{ru(p?.frames || 0)}</b> : <span className={cx("ui-sk pill", l.loading && "ui-shim")} style={{ width: 40, height: 13 }} />}
                    уйдёт при сдаче</span>
                )}
                <span><b>{ru(v.accepted)}</b>в датасете</span>
                <span><b>{ru(v.tracks)}</b>объектов ведётся</span>
                <span><b>{v.frame_count ? ru(v.frame_count) : "—"}</b>кадров в ролике</span>
              </div>
              <TagPicker code={code} all={tags} value={v.tag_ids || []} disabled={!fillable} compact
                placeholder="таг ролика" onChange={(ids) => onVideoTags(v, ids)} onCreated={onTagCreated} />
              {working && p?.error && (
                <p className="t-sm tp-bad"><b>Таску не сдать.</b> {p.error}</p>
              )}
              {/* Строк в таблице — по числу треков из лёгкой части: заготовка той же высоты */}
              {working && !known && v.tracks > 0 && (
                <table className={cx("tp-mini", l.loading && "ui-shim")}>
                  <thead><tr><th>объект</th><th>кадры</th><th className="r">ключей</th><th>шаг</th><th className="r">уйдёт кадров</th></tr></thead>
                  <tbody>
                    {Array.from({ length: v.tracks }, (_, i) => (
                      <tr key={i}>{[80, 90, 20, 50, 40].map((w, k) => <td key={k}><span className="ui-sk pill" style={{ width: w }} /></td>)}</tr>
                    ))}
                  </tbody>
                </table>
              )}
              {working && p && (p.objects || []).length > 0 && (
                <table className={cx("tp-mini", zone)}>
                  <thead><tr><th>объект</th><th>кадры</th><th className="r">ключей</th><th>шаг</th><th className="r">уйдёт кадров</th></tr></thead>
                  <tbody>
                    {(p.objects || []).map((o, i) => {
                      const c = classOf(classes, o);
                      return (
                        <tr key={i} className={o.error ? "bad" : undefined}>
                          <td><span className="tp-cls"><Swatch color={c.color} />{c.name}</span></td>
                          <td className="ui-mono">{ru(o.start)} — {ru(o.end)}</td>
                          <td className="r">{o.keys}{!o.interpolate && " · без интерполяции"}
                            {o.hidden > 0 && ` · ${o.hidden} ${plural(o.hidden, "зона", "зоны", "зон")} невидимости`}</td>
                          <td>{o.step === 1 ? "каждый" : `каждый ${o.step}-й`}</td>
                          <td className="r ui-mono">{o.error ? <em title={o.error}>не считается</em> : ru(o.frames)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {/* Сводка держит место под две строки: пришла короче — то, что ниже, не поднимается */}
              {working && (
                <div className={cx("tp-vsum", zone)}>
                  {!known ? (
                    <><span className="ui-sk pill" style={{ width: "80%" }} /><span className="ui-sk pill" style={{ width: "45%" }} /></>
                  ) : p && !p.error ? (
                    <p className="t-xs t-muted">
                      Размечено {count(p.boxes, "объект", "объекта", "объектов")} на {ru(p.frames - p.empty)}{" "}
                      {plural(p.frames - p.empty, "кадре", "кадрах", "кадрах")}
                      {p.empty > 0 && `, ещё ${p.empty} ${plural(p.empty, "кадр отмечен фоновым", "кадра отмечено фоновыми", "кадров отмечено фоновыми")}`}
                      {(p.singles || 0) > 0 && `, одиночных фигур ${p.singles}`}
                      . {count(p.frames, "кадр", "кадра", "кадров")} {plural(p.frames, "уйдёт", "уйдут", "уйдут")} в датасет при сдаче таски.
                    </p>
                  ) : !p ? <p className="t-xs t-faint">Разметки пока нет — сдавать нечего.</p> : null}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </Card>
  );
}
