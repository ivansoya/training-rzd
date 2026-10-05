// Паспорт набора справа: состояние, образцы и место, деление, предупреждения, классы, обучения на наборе.

import { Link } from "react-router-dom";
import type { Run } from "../../../api/runs";
import type { SetClass, TrainSet } from "../../../api/trainsets";
import { Button, Icon, Legend, Pill, StackBar, Swatch } from "../../../ui";
import { count, ru } from "../../ru";
import { dec } from "../runs/runs";
import { BuildProgress, SetBadge, WarnBadge, when } from "./SetList";
import { SPLIT_MODE, TRAIN, VAL, bytes, map50Of, multiplier } from "./sets";
import type { SetRuns } from "./sets";

/** Сколько кадров класса в val — «мало»: метрика по нему шумит. */
const THIN_VAL = 2;

export function SetPassport({ set, code, classes, warnings, runs, canEdit, building, split, onSimilar }: {
  set: TrainSet;
  /** Кадры проекта по половинам — из отчёта сборки. */
  split: { train: number; val: number } | null;
  code: string;
  classes: SetClass[];
  warnings: string[];
  runs: SetRuns | undefined;
  canEdit: boolean;
  building?: TrainSet;
  onSimilar: () => void;
}) {
  const c = set.counts;
  const ready = set.status === "ready";
  const mult = multiplier(set);
  const list = runs?.runs ?? [];
  const best = runs?.best;
  const top = Math.max(1, ...classes.map((x) => x.train + x.val));

  return (
    <aside className="ui-card ts-pass" aria-label="Паспорт набора">
      <section>
        <h5>Состояние</h5>
        <div className="row" style={{ gap: 8 }}>
          <SetBadge set={set} /><WarnBadge n={c?.warnings ?? 0} />
          <span className="t-xs t-faint">{set.built_at ? `собран ${when(set.built_at)}` : `создан ${when(set.created_at)}`}</span>
        </div>
        {(set.status === "building" || set.status === "deleting") && <BuildProgress set={set} />}
        {set.status === "queued" && (
          <p className="t-sm t-muted">{building ? `Встанет в сборку после «${building.name}».` : "Встанет в сборку, как только освободится сборщик."}
            {" "}Сборка не занимает видеокарту — обучения идут параллельно.</p>
        )}
        {set.status === "error" && (
          <div className="ts-err">
            <Icon name="alert" />
            <span>{set.error ?? "Сборка не удалась."}</span>
            {canEdit && <Button size="sm" icon="refresh" onClick={onSimilar}>Собрать заново</Button>}
          </div>
        )}
      </section>

      {ready && c && (
        <section>
          <h5>Образцы</h5>
          <div className="ts-trio">
            <div><span>всего</span><b className="ui-mono">{ru(c.samples)}</b>{mult && <em>{mult}</em>}</div>
            <div><span>из кадров</span><b className="ui-mono">{ru(c.source_images)}</b></div>
            <div><span>на диске</span><b className="ui-mono">{bytes(set.size_bytes)}</b></div>
          </div>
          {set.hardlinked_bytes > 0 && (
            <span className="t-xs t-faint">{set.size_bytes ? "Оригиналы лежат" : "Все образцы — жёсткие ссылки на файлы проекта:"} ссылками ещё на {bytes(set.hardlinked_bytes)}, место они не занимают.</span>
          )}
        </section>
      )}

      {c && (
        <section>
          <h5>Деление · {SPLIT_MODE[set.split_mode]}</h5>
          <StackBar height={12} label={`train ${c.train}, val ${c.val}`} parts={[
            { value: c.train, color: TRAIN, label: "train" }, { value: c.val, color: VAL, label: "val" },
          ]} />
          <Legend items={[
            { label: <><b className="ui-mono">{ru(c.train)}</b> train</>, color: TRAIN },
            { label: <><b className="ui-mono">{ru(c.val)}</b> val</>, color: VAL },
          ]} />
          {split && split.train + split.val > 0 && (
            <span className="t-xs t-muted">кадров проекта: {ru(split.train)} в train, {ru(split.val)} в val
              ({Math.round((split.val / (split.train + split.val)) * 100)} %)</span>
          )}
          <span className="t-xs t-faint">перемешивание № <span className="ui-mono">{ru(set.seed)}</span> — тот же номер даёт то же деление</span>
        </section>
      )}

      {warnings.length > 0 && (
        <section>
          <h5>Предупреждения</h5>
          <div className="ts-warns">{warnings.map((w) => <Pill key={w} tone="warn">{w}</Pill>)}</div>
        </section>
      )}

      {classes.length > 0 && (
        <section>
          <h5>
            <span>Классы · {classes.length}</span><span className="grow" />
            <Legend items={[{ label: "train", color: TRAIN }, { label: "val", color: VAL }]} />
          </h5>
          <div className="ts-cls">
            {classes.map((x) => {
              const thin = x.train > 0 && x.val <= THIN_VAL;
              return (
                <div key={x.export_id} className="ts-cls-r" title={`train ${ru(x.train)} · val ${ru(x.val)} объектов`}>
                  <Swatch color={x.color} />
                  <span className="t-ell">{x.name}</span>
                  {thin ? <span className="ts-thin" title={x.val ? `В val всего ${x.val} — метрика будет шумной` : "В val нет — качество не измерить"}>
                    <Icon name="alert" size={13} /></span> : <span />}
                  <span className="ts-cbar" style={{ width: `${((x.train + x.val) / top) * 100}%` }}>
                    <i style={{ flex: x.train, background: TRAIN }} /><i style={{ flex: x.val, background: VAL }} />
                  </span>
                </div>
              );
            })}
          </div>
          <span className="t-xs t-faint">объектов в файлах разметки, с копиями</span>
        </section>
      )}

      {ready && (
        <section>
          <h5>
            <span>Обучения на наборе</span><span className="grow" />
            {list.length > 0 && <Link className="t-xs" to={`/projects/${code}/runs?set=${set.id}`}>Все {list.length}</Link>}
          </h5>
          {list.length === 0 ? <p className="t-sm t-muted">На этом наборе ещё не учили.</p> : (
            <ul className="ts-runs">
              {list.slice(0, 4).map((r) => <RunLine key={r.id} r={r} code={code} top={best?.number === r.number} />)}
            </ul>
          )}
        </section>
      )}
    </aside>
  );
}

function RunLine({ r, code, top }: { r: Run; code: string; top: boolean }) {
  const m = map50Of(r);
  return (
    <li>
      <Link to={`/projects/${code}/runs/${r.number}`} className={top ? "ts-run top" : "ts-run"}>
        <span className="ui-mono ts-run-no">№{r.number}</span>
        <span className="ts-run-t"><span className="t-sm">{r.base_model} · {count(r.epochs, "эпоха", "эпохи", "эпох")}</span>
          <span className="t-xs t-faint">{when(r.created_at)}</span></span>
        <span className="ts-run-m"><b className="ui-mono">{m != null ? dec(m) : "—"}</b><span>mAP50</span></span>
        <Icon name="chevR" size={14} />
      </Link>
    </li>
  );
}
