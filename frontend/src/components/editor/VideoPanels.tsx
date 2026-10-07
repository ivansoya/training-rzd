// Панели редактора видео: справа — что на этом кадре, снизу — транспорт.

import type { ClipQuality, LabelClass, VideoTrack } from "../../auth/api";
import { Button, Icon, Select, Seg, Swatch, Switch, cx } from "../../ui";
import type { SelectOption } from "../../ui";
import { fmtConf } from "../mag/BoxCanvas";
import type { CanvasShape } from "../mag/BoxCanvas";
import { exportCount, fmtFrameTime, frameToMs, trackEnd } from "../mag/trackMath";
import { NumInput } from "../NumInput";
import { count, ru } from "../ru";
import { PRESENCE_TEXT, SPEEDS, itemKey, presenceAt, speedText } from "./video";
import type { Item } from "./video";

type Label = (ci: number) => { name: string; color: string };

export function HereSide({ items, shapes, frame, numbers, labelOf, classes, selected, hidden, frozen,
  onSelect, onHide, onClass, onDelete, onToTrack, onPatch }: {
  items: Item[];
  shapes: CanvasShape[];
  frame: number;
  numbers: Map<string, number>;
  labelOf: Label;
  classes: LabelClass[];
  selected: number | null;
  hidden: Set<string>;
  frozen: boolean;
  onSelect: (i: number | null) => void;
  onHide: (key: string) => void;
  onClass: (i: number, ci: number) => void;
  onDelete: (i: number) => void;
  onToTrack: (i: number) => void;
  onPatch: (track: VideoTrack, body: { interpolate?: boolean; export_step?: number }) => void;
}) {
  const options = classes.map((c) => ({
    value: String(c.class_index),
    label: <span className="row"><Swatch color={c.color} />{c.name}</span>,
  }));
  // Непроверенное агента — своей группой сверху, как в редакторе кадров
  const agent = items.map((_, i) => i).filter((i) => shapes[i]?.pending);
  const own = items.map((_, i) => i).filter((i) => !shapes[i]?.pending);
  const row = (i: number) => {
    const it = items[i];
    const ci = it.kind === "track" ? it.track.class_index ?? -1 : it.box.class_index ?? -1;
    const c = labelOf(ci);
    const on = i === selected;
    const key = itemKey(it);
    const off = hidden.has(key);
    const sh = shapes[i];
    const name = it.kind === "track" ? it.track.label || c.name || "Объект" : c.name || "Объект";
    return (
      <div key={key} className={cx("fe-obj", on && "on", off && "off", sh?.pending && "pending")}>
        <div className="fe-obj-r" role="button" tabIndex={0} aria-pressed={on}
          onClick={() => onSelect(on ? null : i)}
          onKeyDown={(e) => { if (e.key === "Enter") onSelect(on ? null : i); }}>
          <Swatch color={c.color} />
          <span className="t-ell grow">{name}</span>
          {it.kind === "track" ? (
            <>
              <span className="ui-mono t-xs t-faint">#{numbers.get(it.track.id)}</span>
              <TrackState track={it.track} frame={frame} />
            </>
          ) : sh?.pending && sh.conf != null ? (
            <span className="ui-mono t-xs fe-conf">{fmtConf(sh.conf)}</span>
          ) : (
            sh && <span className="ui-mono t-xs t-faint">{Math.round(sh.w)}×{Math.round(sh.h)}</span>
          )}
          <Button variant="ghost" size="sm" icon={off ? "eyeoff" : "eye"}
            aria-label={off ? "Показать на кадре" : "Скрыть на кадре"}
            onClick={(e) => { e.stopPropagation(); onHide(key); }} />
        </div>
        {on && (
          <div className="fe-obj-b">
            <Select full size="sm" label={it.kind === "track" ? "Класс трека" : "Класс объекта"} value={String(ci)}
              options={options} disabled={frozen} onChange={(v) => onClass(i, Number(v))} />
            {it.kind === "track" ? (
              <TrackBody track={it.track} frozen={frozen} onPatch={onPatch} onDelete={() => onDelete(i)} />
            ) : (
              <>
                {sh && (
                  <dl className="fe-xywh">
                    {([["x", sh.x], ["y", sh.y], ["w", sh.w], ["h", sh.h]] as const).map(([k, v]) => (
                      <div key={k}><dt>{k}</dt><dd>{Math.round(v)}</dd></div>
                    ))}
                  </dl>
                )}
                {!frozen && (
                  <div className="row wrap">
                    <Button size="sm" variant="ghost" icon="route" disabled={it.box.shape?.kind === "polygon"}
                      title={it.box.shape?.kind === "polygon" ? "Контуром нельзя: трек ведут рамкой" : "Объект начнёт жить во времени"}
                      onClick={() => onToTrack(i)}>Сделать треком</Button>
                    <span className="grow" />
                    <Button size="sm" variant="danger" icon="trash" kbd="Del" onClick={() => onDelete(i)}>Удалить</Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      {agent.length > 0 && (
        <section className="fe-sec fe-objs fe-agent">
          <div className="fe-sec-t">
            <span className="row"><Icon name="bot" size={13} />Агент · на проверке</span>
            <span className="ui-mono">{agent.length}</span>
          </div>
          <div className="fe-list">{agent.map(row)}</div>
        </section>
      )}
      {/* Пустая секция под группой агента — лишняя строка «0» */}
      {(own.length > 0 || agent.length === 0) && (
        <section className="fe-sec fe-objs">
          <div className="fe-sec-t">На этом кадре <span className="ui-mono">{own.length}</span></div>
          {items.length === 0 && <p className="fe-none">На кадре никого нет. T — трек, B или P — разметка только этого кадра.</p>}
          <div className="fe-list">{own.map(row)}</div>
        </section>
      )}
    </>
  );
}

function TrackState({ track, frame }: { track: VideoTrack; frame: number }) {
  const p = presenceAt(track, frame);
  if (!p) return null;
  return <span className={cx("ve-pres", p)}>{PRESENCE_TEXT[p]}</span>;
}

function TrackBody({ track, frozen, onPatch, onDelete }: {
  track: VideoTrack;
  frozen: boolean;
  onPatch: (track: VideoTrack, body: { interpolate?: boolean; export_step?: number }) => void;
  onDelete: () => void;
}) {
  const out = exportCount(track);
  return (
    <>
      <dl className="ve-meta">
        <div><dt>Живёт</dt><dd className="ui-mono">{track.start_frame}–{trackEnd(track)}</dd></div>
        <div><dt>Ключей</dt><dd className="ui-mono">{track.keys.length}</dd></div>
        <div><dt>Уйдёт</dt><dd>{count(out, "кадр", "кадра", "кадров")}</dd></div>
      </dl>
      <label className="ed-set-row">
        <span>Интерполяция</span>
        <Switch label="Интерполяция между ключами" checked={track.interpolate} disabled={frozen}
          onChange={(v) => onPatch(track, { interpolate: v })} />
      </label>
      <label className="ed-set-row">
        <span>Шаг выгрузки</span>
        {/* Число уходит на сервер на уходе из поля: на каждую букву набор «5» давал «15». */}
        <NumInput className="ui-input ui-ctl ui-mono ve-step" value={track.export_step} min={1} integer lazy
          disabled={frozen} aria-label="Шаг выгрузки, кадров"
          onValue={(n) => { if (n !== undefined && n !== track.export_step) onPatch(track, { export_step: n }); }} />
      </label>
      {!frozen && (
        <div className="row">
          <span className="grow" />
          <Button size="sm" variant="danger" icon="trash" onClick={onDelete}>Удалить трек</Button>
        </div>
      )}
    </>
  );
}

/** Ступени качества: готовые и «Исходное» выбираются, остальные видны с ходом подготовки. */
export function qualityOptions(list: ClipQuality[]): SelectOption<string>[] {
  return list.map((q) => {
    const open = q.ready || q.id === "src";
    const wait = q.failed ? "не вышло" : q.chunks ? `готовится ${Math.round((q.prepared / q.chunks) * 100)} %` : "готовится";
    const h = q.height && q.label !== `${q.height}p` ? `${q.height}p` : undefined;
    return { value: q.id, label: q.label, hint: open ? h : wait, disabled: !open };
  });
}

export function Transport({ frame, lastFrame, fps, playing, pending, speed, quality, qualities, empty, frozen, canKey,
  onGo, onPlay, onSpeed, onQuality, onEmpty, onKey }: {
  frame: number;
  lastFrame: number;
  fps: number;
  playing: boolean;
  /** Кадр ещё готовится. */
  pending: boolean;
  speed: number;
  quality: string;
  qualities: ClipQuality[];
  /** Пометка «фоновый» на кадре: off — снята, on — действует, idle — стоит, но на кадре объект. */
  empty: "off" | "on" | "idle" | "busy";
  frozen: boolean;
  canKey: boolean;
  onGo: (delta: number) => void;
  onPlay: () => void;
  onSpeed: (v: number) => void;
  onQuality: (id: string) => void;
  onEmpty: () => void;
  onKey: () => void;
}) {
  const w = String(lastFrame).length;
  return (
    <div className="ve-tr" role="toolbar" aria-label="Проигрывание">
      <Button variant="ghost" size="sm" icon="skipb" aria-label="Назад на 10 кадров (Shift+←)" onClick={() => onGo(-10)} />
      <Button variant="ghost" size="sm" icon="chevL" aria-label="Кадр назад (←)" onClick={() => onGo(-1)} />
      <Button variant="primary" size="sm" icon={playing ? "pause" : "play"} className="ve-play"
        aria-label={playing ? "Остановить (Пробел)" : "Играть (Пробел)"} onClick={onPlay} />
      <Button variant="ghost" size="sm" icon="chevR" aria-label="Кадр вперёд (→)" onClick={() => onGo(1)} />
      <Button variant="ghost" size="sm" icon="skipf" aria-label="Вперёд на 10 кадров (Shift+→)" onClick={() => onGo(10)} />
      <span className="ve-time ui-mono">{fmtFrameTime(frameToMs(frame, fps))}</span>
      {/* Номер добит цифровым пробелом до ширины последнего: строка не дёргается на переходе через десяток */}
      <span className="ve-pos t-sm t-muted">
        кадр <span className="ui-mono">{String(frame).padStart(w, " ")}</span> из <span className="ui-mono">{ru(lastFrame + 1)}</span>
      </span>
      <i className={cx("ve-wait", pending && "on")} aria-hidden={!pending} />
      <span className="grow" />
      <Seg size="sm" label="Скорость" value={String(speed)} onChange={(v) => onSpeed(Number(v))}
        options={SPEEDS.map((v) => ({ value: String(v), label: speedText(v), title: v > 1 ? "Быстрее единицы — через кадр" : undefined }))} />
      <Select size="sm" label="Качество" icon="settings" value={quality || undefined} options={qualityOptions(qualities)}
        onChange={onQuality} />
      <i className="ed-vsep" />
      <Button variant="ghost" size="sm" kbd="E" className={cx("fe-v", "empty", empty === "idle" && "idle")}
        aria-pressed={empty === "on"} disabled={frozen || empty === "busy"}
        title={empty === "busy" ? "На этом кадре есть объект — фоновым он быть не может"
          : empty === "idle" ? "Пометка не действует: на кадре объект. Нажмите, чтобы снять" : "Кадр фоновый: объектов на нём нет"}
        onClick={onEmpty}>Пусто</Button>
      <Button size="sm" icon="diamond" kbd="K" disabled={frozen || !canKey}
        title={canKey ? "Ключ выбранного трека на этом кадре" : "Выберите трек, который живёт на этом кадре"}
        onClick={onKey}>Ключ</Button>
    </div>
  );
}
