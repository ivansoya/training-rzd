// Оборудование: карты, что на них лежит, очередь и права на оборудование.
//
// Три уровня (решения 09.10.2026): сводку карт и свою очередь видит каждый; держателей
// и всю очередь — «Просмотр оборудования»; настройку карт, «Снять» и выдачу прав — «Управление».

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api/gpu";
import type { Device, GpuState, Holder, QueueRow } from "../../api/gpu";
import { useAuth } from "../auth/AuthGate";
import { NumInput } from "../NumInput";
import { Avatar, Badge, Button, Card, Empty, Icon, Input, Legend, Notice, PageHeader, Seg, StackBar, Switch, Table, cx } from "../../ui";
import type { IconName } from "../../ui";
import { count } from "../ru";
import { FREE_COLOR, HATCH, shortName } from "../shell/useGpuState";

const gb = (mb: number) => (mb / 1024).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

// Цвета видов работ — те же, что в сайдбаре и на обзоре проекта.
const KIND: Record<string, [string, string]> = {
  train: ["обучение", "var(--c1)"],
  agent: ["агент разметки", "var(--agent)"],
  embed: ["признаки кадров", "var(--c2)"],
  infer: ["проверка модели", "var(--c3)"],
  preview: ["превью агента", "var(--c5)"],
  examples: ["образцы агента", "var(--c5)"],
};
const kindOf = (k: string) => KIND[k] ?? [k, "var(--c5)"];

const LEVEL: Record<"none" | api.HardwareLevel, { icon: IconName; label: string; desc: string }> = {
  none: { icon: "user", label: "ваш доступ: обычный", desc: "Карты сервера и ваша очередь к ним" },
  view: { icon: "eye", label: "Просмотр оборудования", desc: "Карты сервера, кто их занимает и вся очередь" },
  manage: { icon: "settings", label: "Управление", desc: "Карты сервера, кто их занимает, очередь и права на оборудование" },
};

function since(iso: string | null) {
  if (!iso) return "не отзывалась";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 90) return `${secs} с назад`;
  if (secs < 5400) return `${Math.round(secs / 60)} мин назад`;
  return `${Math.round(secs / 3600)} ч назад`;
}
const waited = (secs: number) => (secs < 60 ? `${secs} с` : `${Math.round(secs / 60)} мин`);

export default function HardwarePage() {
  const [state, setState] = useState<GpuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ошибка действия живёт отдельно от ошибки загрузки: опрос раз в 4 с стирал её раньше, чем её успевали прочесть.
  const [actionError, setActionError] = useState<string | null>(null);
  // Отвергнутое сервером значение оставалось бы в поле — после отказа карточка пересоздаётся с серверными числами.
  const [rev, setRev] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setState(await api.gpuState());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const act = async (call: () => Promise<unknown>) => {
    try {
      await call();
      setActionError(null);
    } catch (e) {
      setActionError((e as Error).message);
      setRev((r) => r + 1);
    }
    void refresh();
  };

  if (!state) {
    return (
      <div className="page hw">
        <PageHeader title="Оборудование" desc={error ? undefined : "Смотрю на карты…"} />
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    );
  }

  const level = LEVEL[state.level ?? "none"];
  const queue = state.staff ? state.queue.queue : state.queue.mine;

  return (
    <div className="page hw">
      <PageHeader title="Оборудование" desc={level.desc}
        actions={<Badge variant={state.level ? undefined : "outline"} icon={level.icon}>{level.label}</Badge>} />
      {actionError && <Notice tone="error" onClose={() => setActionError(null)}>{actionError}</Notice>}

      {state.devices.length === 0 ? (
        <Card><Empty icon="cpu" title="Видеокарт на сервере нет">Карты перечисляет воркер обучения при запуске. Без них агенты и обучение не запустятся.</Empty></Card>
      ) : state.devices.map((d) => (
        <DeviceCard key={`${d.id}-${rev}`} device={d} state={state}
          onLimit={(data) => act(() => api.setLimits(d.id, data))} onKill={(id) => act(() => api.killLease(id))} />
      ))}

      {state.staff && state.settings.sam3_cpu_half && (
        <ModelsCard sam3={state.settings.sam3_cpu_half} manage={state.manage}
          onSam3={(v) => act(() => api.setSetting("sam3_cpu_half", v))} />
      )}

      <Card flush className="hw-q" title={state.staff ? "Очередь" : "Ваши задачи в очереди"}
        desc={state.staff ? (queue.length ? count(queue.length, "задача ждёт", "задачи ждут", "задач ждут") : "никто не ждёт")
          : `${queue.length ? `${queue.length} из ${state.queue.total}` : "ваших задач нет"}${state.queue.total ? ` · всего в очереди ${state.queue.total}` : ""}`}>
        {queue.length === 0 ? (
          <p className="hw-none">{state.staff ? "Карты свободны для новых задач." : "Когда ваша задача будет ждать карту, здесь появится её место и причина."}</p>
        ) : queue.map((row) => (
          <QueueLine key={row.id} row={row} staff={state.staff}
            action={state.manage ? "Снять" : row.mine ? "Отменить" : null} onKill={() => act(() => api.killLease(row.id))} />
        ))}
      </Card>

      {!state.staff && (
        <p className="hw-note"><Icon name="info" size={15} />
          Кто сейчас держит карты и чья задача за вашей, видно с доступом «Просмотр оборудования» — его выдаёт тот, у кого «Управление».
        </p>
      )}

      {state.manage && <AccessCard onError={setActionError} />}

      {state.staff && (
        <p className="t-xs t-faint">
          Живая связь: занято {state.live.used} мест из {state.live.hard}, сейчас открыто до {state.live.soft}.
          Сверх потолка вкладки переходят на опрос и говорят об этом человеку.
        </p>
      )}
    </div>
  );
}

function DeviceCard({ device: d, state, onLimit, onKill }: {
  device: Device; state: GpuState;
  onLimit: (data: { reserved_mb?: number; max_heavy?: number; enabled?: boolean }) => void;
  onKill: (leaseId: string) => void;
}) {
  const off = !d.enabled || !d.fresh;
  const queued = state.queue.total;
  const others = d.held_mb - d.holders.reduce((s, h) => s + h.granted_mb, 0);
  const parts = [
    ...(d.sam2_reserve_mb > 0 ? [{ label: "под разметку", value: d.sam2_reserve_mb, color: HATCH }] : []),
    ...d.holders.map((h) => ({ label: h.what ?? kindOf(h.kind)[0], value: h.granted_mb, color: kindOf(h.kind)[1] })),
    ...(others > 0 ? [{ label: "занято задачами", value: others, color: "var(--faint)" }] : []),
    ...(d.reserved_mb > 0 ? [{ label: "неприкосновенный запас", value: d.reserved_mb, color: "var(--input)" }] : []),
    { label: "свободно", value: d.free_mb, color: FREE_COLOR },
  ];
  const status = !d.enabled ? <span className="hw-warn">выключена</span>
    : !d.fresh ? <span className="hw-warn">не отзывалась {since(d.seen_at).replace(" назад", "")}</span>
      : <span>свободно {gb(d.free_mb)} из {gb(d.cap_mb)} ГБ{queued ? ` · в очереди ${queued}` : ""}</span>;
  const many = state.devices.length > 1;
  return (
    <section className={cx("ui-card hw-card", off && "off")}>
      <header className="hw-h">
        <Icon name="cpu" />
        <b>{many ? `Карта ${d.index} · ` : ""}{shortName(d.name)}</b>
        <span className="t-xs t-faint">{gb(d.total_mb)} ГБ · под задачи {gb(d.cap_mb)}</span>
        <span className="grow" />
        <span className="hw-sum">{status}</span>
      </header>

      {off ? (
        <p className="hw-none">{!d.enabled
          ? "Задачи на неё не ставятся. Включите, когда карта снова в строю."
          : "Задачи на неё не ставятся, пока она не ответит."}</p>
      ) : (
        <div className="hw-b">
          <StackBar parts={parts} height={20} label={`Память карты ${d.name}`} />
          <Legend items={parts.map((p) => ({ label: <>{p.label} <b>{gb(p.value)}</b></>, color: p.color }))} />
        </div>
      )}

      {state.staff && !off && (
        <Table className="hw-tbl">
          <thead>
            <tr><th /><th>Что</th><th>Кто</th><th>Проект</th><th className="r">ГБ</th><th className="r">С</th>{state.manage && <th />}</tr>
          </thead>
          <tbody>
            {d.sam2_reserve_mb > 0 && (
              <tr className="hw-res">
                <td><i className="hw-sw" style={{ background: HATCH }} /></td>
                <td>полуавтомат SAM2 <span className="t-faint">· резерв под разметку</span></td>
                <td className="t-faint">—</td><td className="t-faint">—</td>
                <td className="r">{gb(d.sam2_reserve_mb)}</td><td className="r t-faint">всегда</td>{state.manage && <td />}
              </tr>
            )}
            {d.holders.map((h) => <HolderRow key={h.id} holder={h} manage={state.manage} onKill={() => onKill(h.id)} />)}
            {d.holders.length === 0 && (
              <tr><td /><td colSpan={state.manage ? 6 : 5} className="t-faint">Задач на карте нет</td></tr>
            )}
          </tbody>
        </Table>
      )}

      {state.manage ? (
        <footer className="hw-cfg">
          <label className="hw-f">
            <span>Неприкосновенный запас, ГБ</span>
            <NumInput className="ui-input ui-ctl" lazy value={d.reserved_mb / 1024} min={0} max={Math.round(d.total_mb / 1024)} step={0.5}
              onValue={(v) => v !== undefined && Math.round(v * 1024) !== d.reserved_mb && onLimit({ reserved_mb: Math.round(v * 1024) })} />
          </label>
          <label className="hw-f">
            <span>Тяжёлых задач на карту</span>
            <NumInput className="ui-input ui-ctl" lazy integer value={d.max_heavy} min={1} max={8}
              onValue={(v) => v !== undefined && v !== d.max_heavy && onLimit({ max_heavy: v })} />
          </label>
          <div className="hw-f">
            <span>Карта</span>
            <span className="row hw-sw-l">
              <Switch checked={d.enabled} label="Карта включена" onChange={(v) => onLimit({ enabled: v })} />
              {d.enabled ? "включена" : "выключена"}
            </span>
          </div>
          <span className="grow" />
          <span className="t-xs t-faint hw-seen">{d.fresh ? `отклик ${since(d.seen_at)}` : "Выключите, если её вынули из сервера."}</span>
        </footer>
      ) : state.staff && (
        <footer className="hw-cfg ro">
          <span>Запас <b>{gb(d.reserved_mb)} ГБ</b></span>
          <span>Тяжёлых задач на карту <b>{d.max_heavy}</b></span>
          <span>Включена <b>{d.enabled ? "да" : "нет"}</b></span>
          <span className="grow" />
          <span className="t-xs t-faint">менять может «Управление»</span>
        </footer>
      )}
    </section>
  );
}

/** Как модели грузятся на карты — для всех агентов, превью и прогонов сразу. */
function ModelsCard({ sam3, manage, onSam3 }: { sam3: api.ServerSetting; manage: boolean; onSam3: (v: boolean) => void }) {
  const who = sam3.updated_at
    ? `изменено: ${[sam3.updated_by, new Date(sam3.updated_at).toLocaleDateString("ru-RU")].filter(Boolean).join(" · ")}`
    : "по умолчанию";
  return (
    <Card flush className="hw-models" title="Модели" desc="Как модели грузятся на карты — для всех агентов, превью и прогонов">
      <div className="hw-set">
        <div className="hw-set-t">
          <b>SAM 3: ужимать до переноса на карту</b>
          <span>Модель становится fp16 ещё на процессоре — на карту не едет полная копия. Пик загрузки 3,2 → 1,6 ГБ,
            находки и скорость те же (замер 10.10.2026). Действует со следующей загрузки модели.</span>
        </div>
        <span className="t-xs t-faint hw-set-who">{who}</span>
        {manage ? (
          <span className="row hw-sw-l">
            <Switch checked={sam3.value} label="SAM 3: ужимать до переноса на карту" onChange={onSam3} />
            {sam3.value ? "включено" : "выключено"}
          </span>
        ) : <span className="hw-set-v">{sam3.value ? "включено" : "выключено"}</span>}
      </div>
    </Card>
  );
}

function HolderRow({ holder: h, manage, onKill }: { holder: Holder; manage: boolean; onKill: () => void }) {
  const [label, color] = kindOf(h.kind);
  return (
    <tr>
      <td><i className="hw-sw" style={{ background: color }} /></td>
      <td className="hw-what">{h.what ?? label}{h.detail && <span className="t-faint"> · {h.detail}</span>}</td>
      <td>{h.user ?? <span className="t-faint">—</span>}</td>
      <td>{h.project ?? <span className="t-faint">—</span>}</td>
      <td className="r">{gb(h.granted_mb)}</td>
      <td className="r">{h.granted_at ? clock(h.granted_at) : "—"}</td>
      {manage && <td className="r"><Button size="sm" variant="ghost" className="hw-kill" onClick={onKill}>Снять</Button></td>}
    </tr>
  );
}

function QueueLine({ row, staff, action, onKill }: { row: QueueRow; staff: boolean; action: string | null; onKill: () => void }) {
  const who = [row.what ?? kindOf(row.kind)[0], staff ? row.user : null, row.project].filter(Boolean).join(" · ");
  return (
    <div className={cx("hw-qr", row.mine && "mine")}>
      <span className="hw-n">{row.position}</span>
      <div className="hw-qt">
        <b>{who}{row.detail && <span className="t-faint"> · {row.detail}</span>}{row.mine && staff && <span className="hw-yours">ваша</span>}</b>
        <span>просит <b>{gb(row.want_mb)} ГБ</b> · ждёт <b>{waited(row.waiting_seconds)}</b>{row.reason ? ` — ${row.reason}` : row.position > 1 ? ` — за задачей ${row.position - 1}` : ""}</span>
      </div>
      {action && <Button size="sm" variant={action === "Снять" ? "ghost" : "outline"} className={action === "Снять" ? "hw-kill" : undefined} onClick={onKill}>{action}</Button>}
    </div>
  );
}

type Level = "none" | api.HardwareLevel;
const LEVELS = [
  { value: "none" as Level, label: "Нет" },
  { value: "view" as Level, label: "Просмотр" },
  { value: "manage" as Level, label: "Управление" },
];

function AccessCard({ onError }: { onError: (msg: string) => void }) {
  const { me } = useAuth();
  const [granted, setGranted] = useState<api.AccessRow[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<api.AccessRow[] | null>(null);
  const seq = useRef(0);

  const load = useCallback(() => api.grantedAccess().then((r) => setGranted(r.granted)).catch((e) => onError((e as Error).message)), [onError]);
  useEffect(() => { void load(); }, [load]);

  // Поиск через 250 мс после набора; устаревший ответ отбрасывается по номеру.
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) { setFound(null); return; }
    const n = ++seq.current;
    const t = window.setTimeout(() => {
      api.findPeople(needle).then((r) => { if (n === seq.current) setFound(r.found); }).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const set = async (u: api.AccessRow, level: Level) => {
    try {
      const got = await api.setAccess(u.id, level === "none" ? null : level);
      setFound((f) => f && f.map((x) => (x.id === got.id ? got : x)));
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const person = (u: api.AccessRow, sub: string) => {
    const self = u.id === me.user.id;
    return (
      <div key={u.id} className="hw-ar">
        <Avatar name={u.name || u.login} size={28} />
        <div className="hw-at">
          <b>{u.name || u.login}{self && <span className="t-faint"> · вы</span>}</b>
          <span>{sub}</span>
        </div>
        <Seg<Level> size="sm" label={`Доступ к оборудованию: ${u.name || u.login}`} value={u.level ?? "none"}
          onChange={(v) => void set(u, v)} options={LEVELS.map((o) => ({ ...o, disabled: self }))} />
        <span className="hw-self t-xs t-faint">{self ? "свои права не снять" : ""}</span>
      </div>
    );
  };

  return (
    <Card className="hw-acc" title={<span className="row"><Icon name="lock" size={16} />Доступ</span>}
      desc={granted ? count(granted.length, "человек с правами", "человека с правами", "человек с правами") : "Загружаю…"}>
      <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Логин, почта или имя" aria-label="Найти человека" />
      {found !== null && (
        found.length === 0 ? <p className="t-xs t-muted">Никого не нашлось — проверьте логин или почту.</p>
          : <div className="hw-list">{found.map((u) => person(u, u.level ? `уже есть: ${u.level === "manage" ? "управление" : "просмотр"}` : "прав на оборудование нет"))}</div>
      )}
      <div className="hw-sub">Выдано</div>
      {granted && granted.length > 0 ? (
        <div className="hw-list">{granted.map((u) => person(u, u.login === u.name ? u.email : `${u.login} · ${u.email}`))}</div>
      ) : granted && <p className="t-xs t-muted">Прав не выдано никому, кроме назначенных командой на сервере.</p>}
      <p className="t-xs t-faint">
        «Просмотр» — держатели карт и вся очередь. «Управление» — ещё запас памяти, включение карт, «Снять» и выдача прав.
        Сводку карт и свою очередь видят все. Первого управляющего назначает <code>flask grant-staff</code> на сервере.
      </p>
    </Card>
  );
}
