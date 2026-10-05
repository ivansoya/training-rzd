// Страница набора: слева образцы и схема сборки, справа паспорт.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as runsApi from "../../../api/runs";
import type { Run } from "../../../api/runs";
import { listTags } from "../../../api/tags";
import type { Tag } from "../../../api/tags";
import * as setsApi from "../../../api/trainsets";
import type { Built, SamplesTally, SetClass, TrainSet } from "../../../api/trainsets";
import { useLive } from "../../../live/LiveProvider";
import { Avatar, Button, Card, Empty, LinkButton, Notice, PageHeader } from "../../../ui";
import { count, ru } from "../../ru";
import { useProject } from "../ProjectShell";
import RunDialog from "../runs/RunDialog";
import { useConfirm } from "../tasks/Confirm";
import { SampleGallery } from "./SampleGallery";
import { SetMenu, when } from "./SetList";
import { SetPassport } from "./SetPassport";
import { SetRecipe } from "./SetRecipe";
import { BUSY, SPLIT_MODE, flowsOf, runsBySet } from "./sets";

interface Look { classes: SetClass[]; warnings: string[]; tally: SamplesTally | null }

export default function SetPage() {
  const { code = "", setId = "" } = useParams<{ code: string; setId: string }>();
  const navigate = useNavigate();
  const { detail } = useProject();
  const [set, setSet] = useState<TrainSet | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [look, setLook] = useState<Look>({ classes: [], warnings: [], tally: null });
  const [others, setOthers] = useState<TrainSet[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [missing, setMissing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [training, setTraining] = useState(false);
  const [confirm, confirmNode] = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const got = await setsApi.getSet(code, setId);
      setSet(got);
      setBuilt(got.built ?? null);
      setMissing(null);
      if (got.status === "ready") {
        // Один образец — ради классов, предупреждений и счёта по половинам
        const s = await setsApi.samples(code, setId, { limit: 1 });
        setLook({ classes: s.classes, warnings: s.warnings, tally: s.tally ?? null });
      }
    } catch (e) {
      setMissing((e as Error).message);
    }
    runsApi.listRuns(code).then((r) => setRuns(r.runs)).catch(() => undefined);
    setsApi.listSets(code).then((r) => setOthers(r.sets)).catch(() => undefined);
  }, [code, setId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { listTags(code).then((r) => setTags(r.tags)).catch(() => undefined); }, [code]);
  useLive("*", (e) => { if (["prep", "run", "*"].includes(e.k)) void refresh(); });

  const busy = set ? BUSY.includes(set.status) : false;
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(t);
  }, [busy, refresh]);

  const role = detail?.my_role ?? "viewer";
  const canEdit = role === "admin" || role === "editor";
  const mine = useMemo(() => runsBySet(runs).get(setId), [runs, setId]);
  const tagName = useMemo(() => {
    const m = new Map(tags.map((t) => [t.id, t.name]));
    return (id: string) => m.get(id) ?? "?";
  }, [tags]);
  const flows = useMemo(() => (set ? flowsOf(set, built?.feeds ?? null, tagName) : []), [set, built, tagName]);

  if (missing && !set) {
    return (
      <div className="page ts">
        <Card><Empty icon="layers" title="Набор не найден" action={<LinkButton to={`/projects/${code}/training`} icon="back">Все наборы</LinkButton>}>
          {/^Набор не найден/.test(missing) ? "Его удалили, или в адресе ошибка." : missing}
        </Empty></Card>
      </div>
    );
  }
  if (!set) return <div className="page ts"><p className="t-sm t-muted">Загружаю набор…</p></div>;

  const similar = () => navigate(`/projects/${code}/training/new?from=${set.id}`);
  const remove = async () => {
    const n = mine?.runs.length ?? 0;
    const ok = await confirm({
      title: `Удалить набор «${set.name}»?`, danger: true, icon: "trash", ok: "Удалить",
      desc: n ? `Файлы уйдут с диска. ${count(n, "обучение", "обучения", "обучений")} на нём останутся — с весами и метриками.`
        : "Файлы уйдут с диска.",
    });
    if (!ok) return;
    try {
      await setsApi.deleteSet(code, set.id);
      navigate(`/projects/${code}/training`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const desc = (
    <span className="ts-desc">
      <span>{set.built_at ? `собран ${when(set.built_at)}` : `создан ${when(set.created_at)}`}</span>
      {set.author && <><span className="t-faint">·</span><span className="row" style={{ gap: 6 }}><Avatar name={set.author} size={20} />{set.author}</span></>}
      <span className="t-faint">·</span>
      <span>деление {SPLIT_MODE[set.split_mode]}{set.split_mode !== "manual" ? `, val ${Math.round(set.val_ratio * 100)} %` : ""}</span>
      <span className="t-faint">·</span>
      <span className="ui-mono t-xs t-faint" title="Номер перемешивания — тот же номер даёт то же деление">№ {ru(set.seed)}</span>
    </span>
  );

  return (
    <div className="page ts">
      <PageHeader title={set.name} desc={desc} actions={<>
        {canEdit && <Button icon="copy" onClick={similar} title="Мастер с настройками этого набора">Собрать похожий</Button>}
        {canEdit && <Button variant="primary" icon="play" disabled={set.status !== "ready"} onClick={() => setTraining(true)}
          title={set.status === "ready" ? "Новое обучение на этом наборе" : "Учить можно только собранный набор"}>Учить</Button>}
        <SetMenu set={set} runs={mine?.runs.length ?? 0} canEdit={false} size="md" onSimilar={similar}
          onRuns={() => navigate(`/projects/${code}/runs?set=${set.id}`)} onDelete={() => void remove()} />
      </>} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      <div className="ts-two">
        <div className="ts-main">
          {set.status === "ready"
            ? <SampleGallery code={code} setId={set.id} classes={look.classes} tally={look.tally} />
            : (
              <Card><Empty compact icon="images" title="Образцов пока нет">
                {set.status === "error" ? "Сборка не удалась — причина в паспорте справа." : "Они появятся, когда набор соберётся."}
              </Empty></Card>
            )}
          <SetRecipe set={set} flows={flows} built={built} project={detail} />
        </div>
        <SetPassport set={set} code={code} classes={look.classes} warnings={look.warnings} runs={mine} canEdit={canEdit}
          building={others.find((s) => s.status === "building" && s.id !== set.id)} split={built?.split ?? null}
          onSimilar={similar} />
      </div>

      {training && (
        <RunDialog code={code} seed={{ setId: set.id }} onClose={() => setTraining(false)}
          onStarted={(r) => { setTraining(false); navigate(`/projects/${code}/runs/${r.number}`); }} />
      )}
      {confirmNode}
    </div>
  );
}
