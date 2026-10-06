// Шторка, третья колонка: что узел нашёл на кадре превью по классам и откуда у агента каждый класс.

import type { ReactNode } from "react";
import type { PreviewDet } from "../../api/agents";
import { Meta } from "../../ui";
import { ru } from "../ru";
import type { AgentClass } from "./agentDoc";
import { tally, type AgentKind } from "./look";

export default function AgentFound({ kind, trace, classes, colorOf }: {
  kind: AgentKind | null;
  trace: { in: PreviewDet[]; out: PreviewDet[] } | undefined;
  classes: AgentClass[];
  colorOf: (cls: string) => string;
}) {
  const rows = tally(trace);
  // У сети пришедшие — рамки сетей выше, она их только пропускает и добавляет свои.
  const own = trace && (kind === "net" || kind === "text") ? trace.out.length - trace.in.length : null;
  const gone = trace && kind !== "net" && kind !== "text" ? trace.in.length - trace.out.length : 0;
  const facts: [string, ReactNode][] = !trace ? [] : kind === "frame" ? [["Рамок", <span className="ui-mono">0</span>]] : [
    ["Пришло", <span className="ui-mono">{ru(trace.in.length)}</span>],
    own !== null ? ["Нашёл сам", <span className="ui-mono">{ru(own)}</span>] : ["Отсеял", <span className={gone ? "ui-mono ge-warn" : "ui-mono"}>{ru(gone)}</span>],
    [kind === "output" ? "В разметку" : "Ушло", <span className="ui-mono">{ru(trace.out.length)}</span>],
  ].filter(([k]) => !(kind === "output" && k === "Отсеял")) as [string, ReactNode][];

  return (
    <section className="ge-sec ge-out ae-found">
      <div className="ge-sec-h"><b>Что найдено</b></div>
      {!trace ? <p className="t-xs t-faint">Появится, когда превью посчитает кадр.</p> : <Meta items={facts} />}
      {rows.length > 0 && (
        <div className="ge-out-b">
          <span className="ge-out-t">По классам <span className="t-faint">пришло → ушло</span></span>
          <ul className="ae-tally">
            {rows.map((r) => (
              <li key={r.cls}>
                <i style={{ background: colorOf(r.cls) }} />
                <span className="t-ell" title={r.cls}>{r.cls}</span>
                <span className="ui-mono t-faint">{r.into}</span>
                <span className="ui-mono">{r.out}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ge-out-b">
        <span className="ge-out-t">Классы агента <span className="ui-mono">{classes.length}</span></span>
        {classes.length === 0 ? <p className="t-xs t-faint">Классов нет: выберите веса у «Сети» и включите классы.</p> : (
          <ul className="ae-cls">
            {classes.map((c) => (
              <li key={c.name}>
                <i style={{ background: c.color }} />
                <b className="t-ell" title={c.name}>{c.name}</b>
                {c.sources.length > 1 && <span className="ae-merge" title="В этот класс сходятся несколько источников">×{c.sources.length}</span>}
                <small className="t-ell" title={c.sources.map((s) => s.label).join(", ")}>{c.sources.map((s) => s.label).join(", ")}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
