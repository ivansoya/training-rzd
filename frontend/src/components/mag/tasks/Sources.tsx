// Источники кадров таски карточками: изображения, ролики на нарезку, ролики на разметку, кадры из разметки.

import { useState } from "react";
import type { ReactNode } from "react";
import type { PendingObject, PendingVideo, TaskDetail, TaskVideoItem, VideoPrepare } from "../../../auth/api";
import type { Tag } from "../../../api/tags";
import { Badge, Button, Card, Icon, Legend, MenuItem, Popover, StackBar, Swatch, cx } from "../../../ui";
import { count, plural, ru } from "../../ru";
import { ScoutButton, useScouts } from "../../agents/scout";
import ScoutStats from "../../agents/ScoutStats";
import TagPicker from "../TagPicker";
import VideoStrip from "../VideoStrip";
import { fmtBytes, fmtStep, fmtTime, framesIn } from "../VideoCutModal";
import type { SourceBlock, SourceCounts } from "./tasks";
import { STATES, coverage, dayOf, stateParts } from "./tasks";

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
      ) : <p className="t-faint">Загружать кадры может исполнитель таски или администратор.</p>}
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

function Progress({ c }: { c: SourceCounts }) {
  const left = (c.new || 0) + (c.skipped || 0);
  return (
    <div className="tp-prog">
      <div className="tp-prog-r">
        <StackBar parts={stateParts(c)} height={8} />
        <span className="t-xs t-muted">{left ? `${ru(left)} в работе` : `всё пройдено`}</span>
      </div>
      <StateLegend c={c} />
    </div>
  );
}

function AcceptAgent({ n, onAccept }: { n?: number; onAccept?: () => void }) {
  if (!n || !onAccept) return null;
  return (
    <Button variant="ghost" size="sm" icon="bot" className="is-agent" onClick={onAccept}
      title="Кадры с непроверенной разметкой агента станут размеченными">
      Принять агента <span className="ui-mono">{ru(n)}</span>
    </Button>
  );
}

/** Изображения или кадры из закрытой разметки ролика. */
export function FramesCard({ block, editable, onAnnotate, onAcceptAgent }: {
  block: SourceBlock;
  editable: boolean;
  onAnnotate: () => void;
  onAcceptAgent?: () => void;
}) {
  const files = block.kind === "files";
  return (
    <Card className="tp-src"
      title={<><Icon name={files ? "images" : "eye"} />{block.title}<Badge variant="secondary">{ru(block.total)}</Badge></>}
      desc={block.counts.first_at ? `с ${dayOf(block.counts.first_at)}` : undefined}
      actions={<>
        {editable && <AcceptAgent n={block.counts.agent} onAccept={onAcceptAgent} />}
        {block.total > 0 && (
          <Button size="sm" icon={editable ? "edit" : "eye"} onClick={onAnnotate}>
            {!editable ? "Смотреть" : files ? "Размечать" : "Проверить"}
          </Button>
        )}
      </>}>
      <Progress c={block.counts} />
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
export function CutCard({ block, taskId, code, tags, editable, onAnnotate, onAcceptAgent, onCut, onDelete, onVideoTags, onTagCreated }: {
  block: SourceBlock;
  taskId: string;
  code: string;
  tags: Tag[];
  editable: boolean;
  onAnnotate: () => void;
  onAcceptAgent: () => void;
  onCut: (v: TaskVideoItem) => void;
  onDelete: (v: TaskVideoItem) => void;
  onVideoTags: (v: TaskVideoItem, ids: string[]) => void;
  onTagCreated: (t: Tag) => void;
}) {
  const videos = block.videos || [];
  const scouts = useScouts(taskId);
  const [stats, setStats] = useState<string | null>(null);
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
        {editable && <AcceptAgent n={block.counts.agent} onAccept={onAcceptAgent} />}
        {block.total > 0 && (
          <Button size="sm" icon={editable ? "edit" : "eye"} onClick={onAnnotate}>{editable ? "Размечать нарезанное" : "Смотреть"}</Button>
        )}
      </>}>
      {block.total > 0 && <Progress c={block.counts} />}
      {editable && videos.length > 1 && (
        <div className="tp-tagall">
          <span className="t-xs t-muted">Таг на все {videos.length}</span>
          <TagPicker code={code} all={tags} value={common} compact placeholder="таг на все ролики"
            onChange={tagAll} onCreated={onTagCreated} />
        </div>
      )}
      <div className="tp-reels">
        {videos.map((v) => (
          <ReelRow key={v.id} v={v} taskId={taskId} code={code} tags={tags} editable={editable}
            scout={<ScoutButton scout={scouts[v.id]} onOpen={() => setStats(v.id)} />}
            onCut={() => onCut(v)} onDelete={() => onDelete(v)}
            onTags={(ids) => onVideoTags(v, ids)} onTagCreated={onTagCreated} />
        ))}
      </div>
      {stats && <ScoutStats taskId={taskId} videoId={stats} onClose={() => setStats(null)} />}
    </Card>
  );
}

function ReelRow({ v, taskId, code, tags, editable, scout, onCut, onDelete, onTags, onTagCreated }: {
  v: TaskVideoItem;
  taskId: string;
  code: string;
  tags: Tag[];
  editable: boolean;
  scout: ReactNode;
  onCut: () => void;
  onDelete: () => void;
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
        <span className="tp-reel-s">{scout}<PrepareLine prepare={v.prepare} /></span>
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
        {editable && <Button variant="ghost" size="sm" icon="trash" onClick={onDelete} aria-label={`Убрать ${v.file_name} и нарезанные из него кадры`} />}
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

type TaskClass = TaskDetail["classes"][number];

function classOf(classes: TaskClass[], o: PendingObject): { name: string; color: string | null } {
  if (o.class_name) return { name: o.class_name, color: o.class_color || null };
  const found = classes.find((c) => c.class_index === o.class_index);
  return found ? { name: found.name, color: found.color }
    : { name: o.class_index === null ? "класс не задан" : `класс ${o.class_index}`, color: null };
}

/** Ролики на разметку: каждый со своей шкалой, объектами и закрытием. */
export function AnnotateCard({ videos, pending, classes, taskId, code, tags, editable, busy, onAdd, onOpen, onClose, onReopen, onDropFrames, onDelete, onVideoTags, onTagCreated }: {
  videos: TaskVideoItem[];
  pending: PendingVideo[];
  classes: TaskClass[];
  taskId: string;
  code: string;
  tags: Tag[];
  editable: boolean;
  busy: boolean;
  onAdd: () => void;
  onOpen: (v: TaskVideoItem) => void;
  onClose: (v: TaskVideoItem) => void;
  onReopen: (v: TaskVideoItem) => void;
  onDropFrames: (v: TaskVideoItem) => void;
  onDelete: (v: TaskVideoItem) => void;
  onVideoTags: (v: TaskVideoItem, ids: string[]) => void;
  onTagCreated: (t: Tag) => void;
}) {
  const scouts = useScouts(taskId);
  const [stats, setStats] = useState<string | null>(null);
  return (
    <Card className="tp-src" flush
      title={<><Icon name="film" />Ролики на разметку<Badge variant="secondary">{videos.length}</Badge></>}
      desc="размечаются треками, кадрами становятся при закрытии разметки"
      actions={editable && <Button size="sm" icon="plus" onClick={onAdd}>Видео на разметку</Button>}>
      {videos.map((v) => {
        const p = pending.find((x) => x.video_id === v.id);
        const closed = v.annotation_closed_at !== null;
        const inTask = Math.max(v.frames, p?.frames_in_task ?? 0);
        return (
          <div key={v.id} className="tp-vid">
            <VideoStrip className="tp-poster big" taskId={taskId} videoId={v.id} />
            <div className="tp-vid-b">
              <div className="tp-vid-h">
                <b className="t-ell" title={v.file_name}>{v.file_name}</b>
                {closed ? <Badge tone="var(--st-done)" icon="lock">разметка закрыта</Badge>
                  : <Badge tone="var(--c1)" live>размечается</Badge>}
                <ScoutButton scout={scouts[v.id]} onOpen={() => setStats(v.id)} />
                <span className="grow" />
                {editable && !closed && (
                  <Button variant="primary" size="sm" icon="lock" disabled={busy || !p || !!p.error} onClick={() => onClose(v)}
                    title={!p ? "Размечать нечего — на ролике нет ни боксов, ни фоновых кадров" : p.error || "Превратить разметку в кадры таски"}>
                    Закрыть разметку
                  </Button>
                )}
                {editable && closed && <Button variant="ghost" size="sm" icon="unlock" disabled={busy} onClick={() => onReopen(v)}>Открыть заново</Button>}
                <Button size="sm" icon={editable && !closed ? "edit" : "eye"} disabled={!v.prepare?.ready}
                  title={v.prepare?.ready ? undefined : "Ролик ещё готовится"} onClick={() => onOpen(v)}>
                  {editable && !closed ? "Размечать ролик" : "Смотреть"}
                </Button>
                {editable && <Button variant="ghost" size="sm" icon="trash" onClick={() => onDelete(v)}
                  aria-label={`Убрать ${v.file_name} и всё, что из него вышло и ещё не в датасете`} />}
              </div>
              <span className="t-xs t-muted">
                {fmtTime(v.duration_ms || 0)} · {v.width}×{v.height} · {v.fps} к/с · {fmtBytes(v.size_bytes)}
                {" "}<PrepareLine prepare={v.prepare} />
              </span>
              <Rail parts={coverage(v, p?.objects)} tone="track" />
              <div className="tp-vnums">
                <span><b>{ru(v.frames || p?.frames || 0)}</b>{v.frames ? "кадров в таске" : "кадров уйдёт в таску"}</span>
                <span><b>{ru(v.tracks)}</b>объектов ведётся</span>
                <span><b>{v.frame_count ? ru(v.frame_count) : "—"}</b>кадров в ролике</span>
              </div>
              <TagPicker code={code} all={tags} value={v.tag_ids || []} disabled={!editable || closed} compact
                placeholder="таг ролика" onChange={(ids) => onVideoTags(v, ids)} onCreated={onTagCreated} />
              {editable && inTask > 0 && (
                <p className="t-sm t-muted">
                  У ролика {count(inTask, "кадр", "кадра", "кадров")} в таске. Чтобы разметить его заново,{" "}
                  <button type="button" className="tp-link" disabled={busy} onClick={() => onDropFrames(v)}>уберите их</button>
                  {" "}— принятые в проект останутся.
                </p>
              )}
              {!closed && p?.error && !(editable && inTask > 0) && (
                <p className="t-sm tp-bad"><b>Разметку не закрыть.</b> {p.error}</p>
              )}
              {!closed && p && (p.objects || []).length > 0 && (
                <table className="tp-mini">
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
              {!closed && p && !p.error && (
                <p className="t-xs t-muted">
                  Размечено {count(p.boxes, "объект", "объекта", "объектов")} на {ru(p.frames - p.empty)}{" "}
                  {plural(p.frames - p.empty, "кадре", "кадрах", "кадрах")}
                  {p.empty > 0 && `, ещё ${p.empty} ${plural(p.empty, "кадр отмечен фоновым", "кадра отмечено фоновыми", "кадров отмечено фоновыми")}`}
                  {(p.singles || 0) > 0 && `, одиночных фигур ${p.singles}`}
                  . {count(p.frames, "кадр", "кадра", "кадров")} {plural(p.frames, "появится", "появятся", "появятся")} в таске, когда закроете разметку.
                </p>
              )}
            </div>
          </div>
        );
      })}
      {stats && <ScoutStats taskId={taskId} videoId={stats} onClose={() => setStats(null)} />}
    </Card>
  );
}
