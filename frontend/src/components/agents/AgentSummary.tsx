// Узел «Выход» в шторке: сводка агента целиком — время и вызовы модели по узлам на кадре превью,
// худший кадр проекта по потолку вызовов, классы агента с источниками и счётом на кадре.

import type { CSSProperties } from "react";
import { Button, Icon, Swatch, cx } from "../../ui";
import { count, plural, ru } from "../ru";
import { MAX_PASSES } from "./agentDoc";
import { iconOf, toneOf } from "./look";
import type { ClassStat, NodeStat } from "./summary";

const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)} мс`
  : `${(ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`);

export default function AgentSummary({ nodes, classes, frame, worst, sequential, onClasses, onNode }: {
  nodes: NodeStat[];
  classes: ClassStat[];
  /** Кадр превью; null — превью ещё не посчитано. */
  frame: { w: number; h: number; name: string } | null;
  /** Самый большой кадр проекта превью и вызовов на нём, если он больше кадра превью. */
  worst: { w: number; h: number; calls: number } | null;
  /** Превью шло поочерёдно: целиком агент не влезает — время выше, чем будет на свободной карте. */
  sequential: boolean;
  onClasses: () => void;
  /** Выделить узел на холсте. */
  onNode: (id: string) => void;
}) {
  const total = nodes.reduce((s, n) => s + (n.ms ?? 0), 0);
  const calls = nodes.reduce((s, n) => s + (n.calls ?? 0), 0);
  const timed = nodes.some((n) => n.ms !== undefined);
  const top = Math.max(1, ...nodes.map((n) => n.ms ?? 0));
  const boxes = classes.reduce((s, c) => s + c.count, 0);
  const most = Math.max(1, ...classes.map((c) => c.count));

  return (
    <>
      <section className="ae-panel">
        <div className="ae-panel-h">
          <b>Время и вызовы модели</b>
          <span className="ae-readout">
            {timed ? <>≈ {took(total)} <em>на кадр</em></> : <em>время — после превью</em>}
            <em> · {count(calls, "вызов", "вызова", "вызовов")}{sequential ? " · поочерёдно" : ""}</em>
          </span>
        </div>
        <div className="ae-st">
          <div className="ae-st-r head"><span>Узел</span><span>Модель</span><span className="r">Вызовов</span><span className="r">Время</span><span /></div>
          {nodes.map((n) => (
            <button key={n.id} type="button" className="ae-st-r" style={{ "--gc": toneOf(n.kind) } as CSSProperties}
              title="Выделить узел на холсте" onClick={() => onNode(n.id)}>
              <span className="ae-st-n"><Icon name={iconOf(n.kind)} size={14} /><b className="t-ell">{n.title}</b></span>
              <span className="ae-st-m t-ell" title={n.model}>
                {n.model}{n.views !== null && n.views > 1 ? ` · ${count(n.views, "вид", "вида", "видов")}` : ""}
              </span>
              <span className="r ui-mono">
                {n.calls !== null ? ru(n.calls) : n.boxes !== null ? <span title="Кадр кодируется один раз, рамки декодируются за миллисекунды">1 + {ru(n.boxes)}</span> : "—"}
              </span>
              <span className="r ui-mono">{n.ms !== undefined ? took(n.ms) : "—"}</span>
              <span className="ae-st-bar"><i style={{ width: `${((n.ms ?? 0) / top) * 100}%` }} /></span>
            </button>
          ))}
        </div>
        <div className="ae-panel-row ae-st-f">
          <span className="ae-panel-l">Кадр</span>
          <span className="ae-panel-v">
            {frame ? `${frame.name} · ${frame.w}×${frame.h}` : "появится, когда превью посчитает кадр"}
            {worst && (
              <span className={cx("ae-st-worst", worst.calls > MAX_PASSES && "bad")}>
                {" "}· самый большой в проекте {worst.w}×{worst.h} — {count(worst.calls, "вызов", "вызова", "вызовов")}
                {worst.calls > MAX_PASSES ? `, больше ${MAX_PASSES} нельзя` : ""}
              </span>
            )}
          </span>
          <span />
        </div>
        {calls > MAX_PASSES && (
          <div className="ae-panel-row ae-st-f">
            <span className="ae-panel-l bad">Потолок</span>
            <span className="ae-panel-v bad">Больше {MAX_PASSES} вызовов модели на кадр нельзя — увеличьте тайлы или уберите образцы</span>
            <span />
          </div>
        )}
      </section>

      <section className="ae-panel">
        <div className="ae-panel-h">
          <b>Классы агента</b>
          <span className="ae-st-h-r">
            <span className="ae-readout">{ru(boxes)} <em>{plural(boxes, "рамка", "рамки", "рамок")} на кадре · {count(classes.length, "класс", "класса", "классов")}</em></span>
            <Button size="sm" variant="ghost" icon="tags" onClick={onClasses}>Изменить…</Button>
          </span>
        </div>
        {classes.length === 0 ? <p className="ae-st-none">Классов нет: выберите веса у «Сети» или добавьте класс в «Сеть по тексту».</p> : (
          <div className="ae-st">
            <div className="ae-st-r cls head"><span /><span>Класс</span><span>Откуда</span><span /><span className="r">На кадре</span></div>
            {classes.map(({ cls, count: n, from }) => (
              <div key={cls.id} className="ae-st-r cls">
                <Swatch color={cls.color} />
                <span className="ae-st-c">
                  <b className="t-ell" title={cls.name}>{cls.name}</b>
                  {cls.ref?.project_name && <span className="ui-mono">{cls.ref.project_name}</span>}
                </span>
                <span className="ae-st-src">
                  {from.map((f) => (
                    <span key={f.node} className="t-ell" title={`${f.title}: ${f.labels.join(", ")}`}>
                      <b>{f.title}</b> · {f.labels.join(", ")}
                    </span>
                  ))}
                </span>
                <span className="ae-st-bar" style={{ "--gc": cls.color } as CSSProperties}><i style={{ width: `${(n / most) * 100}%` }} /></span>
                <span className={cx("r ui-mono", n === 0 && "t-faint")}>{ru(n)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
