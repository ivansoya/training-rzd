// Шторка, под превью: что узел, на который смотрит превью, сделал с рамками этого кадра.
// Уравнение «пришло ± своё = ушло» и полосы по классам, как «Чем размечено» на странице таски.
// Классы агента целиком — в окне «Классы агента» из шапки, не здесь: они не про узел и не про кадр.

import type { CSSProperties } from "react";
import type { PreviewDet } from "../../api/agents";
import { Swatch, cx } from "../../ui";
import { ru } from "../ru";
import { tally, type AgentKind } from "./look";

const SEARCH: AgentKind[] = ["net", "text"];

export default function AgentFound({ kind, title, trace, colorOf }: {
  kind: AgentKind | null;
  /** Подпись узла, на который смотрит превью: он не всегда выделенный. */
  title: string | null;
  trace: { in: PreviewDet[]; out: PreviewDet[] } | undefined;
  colorOf: (cls: string) => string;
}) {
  const search = kind !== null && SEARCH.includes(kind);
  const head = kind === "output" ? "Что уйдёт в разметку" : search ? "Что нашёл узел" : "Что прошло через узел";
  const rows = tally(trace);
  const top = Math.max(1, ...rows.map((r) => Math.max(r.out, r.into)));

  let body;
  if (!trace) body = <p className="ae-f-none">Появится, когда превью посчитает кадр.</p>;
  else if (kind === "frame") body = <p className="ae-f-none">Кадр рамок не несёт — с него начинается поиск.</p>;
  else {
    const into = trace.in.length, out = trace.out.length;
    // Поиск пропускает пришедшее и добавляет своё; прочие узлы только отсеивают.
    const terms = kind === "output"
      ? [{ n: out, l: "рамок агента на кадре", main: true }]
      : search
        ? [{ n: into, l: "пришло сверху" }, { op: "+", n: out - into, l: "нашёл сам", main: true }, { op: "=", n: out, l: "ушло дальше" }]
        : [{ n: into, l: "пришло" }, { op: "−", n: into - out, l: "отсеял", warn: into > out }, { op: "=", n: out, l: "ушло дальше", main: true }];
    body = (
      <>
        <div className="ae-eq">
          {terms.map((t, k) => (
            <div key={k} className="ae-eq-t">
              {"op" in t && t.op && <span className="ae-eq-op">{t.op}</span>}
              <span className={cx("ae-eq-c", "main" in t && t.main && "main", "warn" in t && t.warn && "warn")}>
                <b className="ui-mono">{ru(t.n)}</b><small>{t.l}</small>
              </span>
            </div>
          ))}
        </div>
        {rows.length > 0 && (
          <div className="ae-f-cls">
            <div className="ae-f-h">
              <h5>По классам</h5>
              {rows.some((r) => r.into > r.out) && !search && <span className="ae-f-key"><i />отсеяно</span>}
            </div>
            {rows.map((r) => {
              const own = r.out - r.into;
              return (
                <div key={r.cls} className="ae-fbar" title={r.cls} style={{ "--cc": colorOf(r.cls) } as CSSProperties}>
                  <Swatch color={colorOf(r.cls)} />
                  <span className="t-ell">{r.cls}</span>
                  <span className="ae-fbar-t">
                    <i style={{ width: `${(r.out / top) * 100}%` }} />
                    {r.into > r.out && <s style={{ width: `${((r.into - r.out) / top) * 100}%` }} />}
                  </span>
                  <b className="ui-mono">{ru(r.out)}</b>
                  <small className="ui-mono">
                    {search ? (r.into > 0 && own > 0 ? `+${ru(own)}` : "") : r.into !== r.out ? `из ${ru(r.into)}` : ""}
                  </small>
                </div>
              );
            })}
          </div>
        )}
        {rows.length === 0 && kind !== "output" && <p className="ae-f-none">На этом кадре рамок нет.</p>}
      </>
    );
  }

  return (
    <section className="ge-sec ae-found">
      <div className="ae-f-title">
        <b>{head}</b>
        {title && <span className="t-ell" title={title}>{title}</span>}
      </div>
      {body}
    </section>
  );
}
