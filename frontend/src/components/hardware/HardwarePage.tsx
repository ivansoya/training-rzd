// Оборудование: карты, что на них лежит, очередь и права на оборудование.
//
// Три уровня (решения 09.10.2026): сводку карт и свою очередь видит каждый; держателей
// и всю очередь — «Просмотр оборудования»; настройку карт, «Снять» и выдачу прав — «Управление».
// Карты — таблицей, строка на карту (решения 10.10.2026): на сервере их бывает восемь, а
// карточка на каждую уводила очередь за экран. Одна карта — подробности открыты сразу.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as api from "../../api/gpu";
import type { Device, GpuState, Holder, QueueRow } from "../../api/gpu";
import { useAuth } from "../auth/AuthGate";
import { NumInput } from "../NumInput";
import { Avatar, Badge, Button, Card, Empty, Icon, Input, Legend, Notice, PageHeader, Seg, StackBar, Switch, Table, cx } from "../../ui";
import type { IconName } from "../../ui";
import { count } from "../ru";
import { FREE_COLOR, HATCH, cardList, gb, kindOf, liveDevices, shortName } from "../shell/useGpuState";

const clock = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

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
// Большая задача без брони может ждать часами (решение 11.10.2026) — и это должно читаться.
const waited = (secs: number) => (secs < 60 ? `${secs} с` : secs < 5400 ? `${Math.round(secs / 60)} мин`
  : `${Math.floor(secs / 3600)} ч ${Math.round((secs % 3600) / 60)} мин`);

export default function HardwarePage() {
  const [state, setState] = useState<GpuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ошибка действия живёт отдельно от ошибки загрузки: опрос раз в 4 с стирал её раньше, чем её успевали прочесть.
  const [actionError, setActionError] = useState<string | null>(null);
  // Отвергнутое сервером значение оставалось бы в поле — после отказа карточка пересоздаётся с серверными числами.
  const [rev, setRev] = useState(0);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

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
  const many = state.devices.length > 1;
  const working = liveDevices(state);
  const models = state.staff && state.settings.sam3_cpu_half;

  return (
    <div className="page hw">
      <PageHeader title="Оборудование" desc={level.desc}
        actions={<Badge variant={state.level ? undefined : "outline"} icon={level.icon}>{level.label}</Badge>} />
      {actionError && <Notice tone="error" onClose={() => setActionError(null)}>{actionError}</Notice>}

      {many && (
        <div className="hw-total">
          <span><b>{working.length}</b>из {count(state.devices.length, "карты", "карт", "карт")} в работе</span>
          <span><b>{gb(working.reduce((s, d) => s + d.free_mb, 0))}</b>ГБ свободно из {gb(working.reduce((s, d) => s + d.cap_mb, 0))}</span>
          {state.staff && <span><b>{working.reduce((s, d) => s + d.holders.length, 0)}</b>задач на картах</span>}
          <span><b>{state.queue.total}</b>в очереди</span>
        </div>
      )}

      <div className="hw-grid">
        <Card flush className="hw-cards" title="Карты">
          {state.devices.length === 0 ? (
            <Empty icon="cpu" title="Видеокарт на сервере нет">Карты перечисляет воркер обучения при запуске. Без них агенты и обучение не запустятся.</Empty>
          ) : (
            <Table className="hw-tbl">
              <thead>
                <tr><th className="hw-chev" /><th className="hw-i">№</th><th>Карта</th><th>Память</th><th className="r">Свободно, ГБ</th><th>Задачи</th><th>Состояние</th></tr>
              </thead>
              <tbody>
                {state.devices.map((d) => (
                  <DeviceRows key={`${d.id}-${rev}`} device={d} state={state} many={many} open={!many || open.has(d.id)}
                    onToggle={() => setOpen((s) => { const next = new Set(s); if (!next.delete(d.id)) next.add(d.id); return next; })}
                    onLimit={(data) => act(() => api.setLimits(d.id, data))} onKill={(id) => act(() => api.killLease(id))} />
                ))}
              </tbody>
            </Table>
          )}
        </Card>

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
      </div>

      {!state.staff && (
        <p className="hw-note"><Icon name="info" size={15} />
          Кто сейчас держит карты и чья задача за вашей, видно с доступом «Просмотр оборудования» — его выдаёт тот, у кого «Управление».
        </p>
      )}

      {(models || state.manage) && (
        <div className="hw-low">
          {models && <ModelsCard sam3={models} manage={state.manage}
            onSam3={(v) => act(() => api.setSetting("sam3_cpu_half", v))} />}
          {state.manage && <AccessCard onError={setActionError} />}
        </div>
      )}

      {state.staff && (
        <p className="t-xs t-faint">
          Живая связь: занято {state.live.used} мест из {state.live.hard}, сейчас открыто до {state.live.soft}.
          Сверх потолка вкладки переходят на опрос и говорят об этом человеку.
        </p>
      )}
    </div>
  );
}

/** Карта — строкой таблицы; раскрытая — ещё строкой с держателями и настройками. */
function DeviceRows({ device: d, state, many, open, onToggle, onLimit, onKill }: {
  device: Device; state: GpuState; many: boolean; open: boolean; onToggle: () => void;
  onLimit: (data: { reserved_mb?: number; max_heavy?: number; enabled?: boolean }) => void;
  onKill: (leaseId: string) => void;
}) {
  const off = !d.enabled || !d.fresh;
  const others = d.held_mb - d.holders.reduce((s, h) => s + h.granted_mb, 0);
  const parts = [
    ...(d.sam2_reserve_mb > 0 ? [{ label: "под разметку", value: d.sam2_reserve_mb, color: HATCH }] : []),
    ...d.holders.map((h) => ({ label: h.what ?? kindOf(h.kind)[0], value: h.granted_mb, color: kindOf(h.kind)[1] })),
    ...(others > 0 ? [{ label: "занято задачами", value: others, color: "var(--faint)" }] : []),
    ...(d.reserved_mb > 0 ? [{ label: "неприкосновенный запас", value: d.reserved_mb, color: "var(--input)" }] : []),
    { label: "свободно", value: d.free_mb, color: FREE_COLOR },
  ];
  const kinds = [...new Set(d.holders.map((h) => h.kind))];
  const state_ = !d.enabled ? <span className="hw-st bad">выключена</span>
    : !d.fresh ? <span className="hw-st bad">не отзывалась {since(d.seen_at).replace(" назад", "")}</span>
      : d.held_mb > 0 ? <span className="hw-st ok">работает</span> : <span className="hw-st">свободна</span>;
  const toggle = many ? {
    tabIndex: 0, "aria-expanded": open, onClick: onToggle,
    onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } },
  } : {};
  return (
    <>
      <tr className={cx("hw-dev", open && "open", off && "off", many && "click")} {...toggle}>
        <td className="hw-chev">{many && <Icon name="chevR" size={14} />}</td>
        <td className="hw-i">{d.index}</td>
        <td className="hw-name"><b>{shortName(d.name)}</b><span>{gb(d.total_mb)} ГБ</span></td>
        <td className="hw-mem">{off ? <span className="t-faint">задачи не ставятся</span>
          : <StackBar parts={parts} height={10} label={`Память карты ${d.index}`} />}</td>
        <td className="r">{off ? "—" : <>{gb(d.free_mb)} <span className="t-faint">из {gb(d.cap_mb)}</span></>}</td>
        <td>
          <span className="hw-kinds">
            {state.staff ? d.holders.length || "—" : off || d.held_mb === 0 ? "—" : ""}
            {kinds.map((k) => <i key={k} style={{ background: kindOf(k)[1] }} title={kindOf(k)[0]} />)}
          </span>
        </td>
        <td>{state_}</td>
      </tr>
      {open && (
        <tr className="hw-det">
          <td colSpan={7}>
            <div className="hw-in">
              {off ? (
                <p className="hw-none">{!d.enabled
                  ? "Задачи на неё не ставятся. Включите, когда карта снова в строю."
                  : "Задачи на неё не ставятся, пока она не ответит."}</p>
              ) : (
                <Legend items={parts.map((p) => ({ label: <>{p.label} <b>{gb(p.value)}</b></>, color: p.color }))} />
              )}
              {state.staff && !off && (
                <div className="hw-hold">
                  <table>
                    <tbody>
                      {d.sam2_reserve_mb > 0 && (
                        <tr className="hw-res">
                          <td className="hw-sw-c"><i className="hw-sw" style={{ background: HATCH }} /></td>
                          <td className="hw-what">полуавтомат SAM2 <span className="t-faint">· резерв под разметку</span></td>
                          <td className="t-faint">—</td><td className="t-faint">—</td>
                          <td className="r">{gb(d.sam2_reserve_mb)}</td><td className="r t-faint">всегда</td>{state.manage && <td />}
                        </tr>
                      )}
                      {d.holders.map((h) => <HolderRow key={h.id} holder={h} manage={state.manage} onKill={() => onKill(h.id)} />)}
                      {d.holders.length === 0 && (
                        <tr><td className="hw-sw-c" /><td colSpan={state.manage ? 6 : 5} className="t-faint">Задач на карте нет</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              <CardSettings device={d} state={state} onLimit={onLimit} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** Запас, потолок тяжёлых и включение карты: меняет «Управление», видит «Просмотр». */
function CardSettings({ device: d, state, onLimit }: {
  device: Device; state: GpuState;
  onLimit: (data: { reserved_mb?: number; max_heavy?: number; enabled?: boolean }) => void;
}) {
  return (
    <>
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
    </>
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
  // Часть задачи на нескольких картах: «SAM 3 · вход 1008», «батч 8 на карту».
  const tail = [h.detail, h.label].filter(Boolean).join(" · ");
  return (
    <tr>
      <td className="hw-sw-c"><i className="hw-sw" style={{ background: color }} /></td>
      <td className="hw-what">{h.what ?? label}
        {h.cards && h.cards.length > 1 && <span className="hw-multi">карты {cardList(h.cards)}</span>}
        {tail && <span className="t-faint"> · {tail}</span>}</td>
      <td>{h.user ?? <span className="t-faint">—</span>}</td>
      <td>{h.project ?? <span className="t-faint">—</span>}</td>
      <td className="r">{gb(h.granted_mb)}</td>
      <td className="r">{h.granted_at ? clock(h.granted_at) : "—"}</td>
      {manage && <td className="r"><Button size="sm" variant="ghost" className="hw-kill" onClick={onKill}>Снять</Button></td>}
    </tr>
  );
}

function QueueLine({ row, staff, action, onKill }: { row: QueueRow; staff: boolean; action: string | null; onKill: () => void }) {
  const who = [staff ? row.user : null, row.project].filter(Boolean).join(" · ");
  // Задача на нескольких картах — одной строкой: «4 × 6,1 ГБ», ждёт все карты сразу.
  const multi = row.parts && row.parts.length > 1 ? row.parts : null;
  const want = multi ? (multi.every((p) => p === multi[0]) ? `${multi.length} × ${gb(multi[0])}` : multi.map(gb).join(" + ")) : gb(row.want_mb);
  return (
    <div className={cx("hw-qr", row.mine && "mine")}>
      <span className="hw-n">{row.position}</span>
      <div className="hw-qt">
        <b>{row.what ?? kindOf(row.kind)[0]}{row.detail && <span className="t-faint"> · {row.detail}</span>}
          {multi && <span className="hw-multi">{count(multi.length, "карта", "карты", "карт")}</span>}
          {row.mine && staff && <span className="hw-yours">ваша</span>}</b>
        {who && <span>{who}</span>}
        <span>просит <b>{want} ГБ</b> · ждёт <b>{waited(row.waiting_seconds)}</b>{row.reason ? ` — ${row.reason}` : row.position > 1 ? ` — за задачей ${row.position - 1}` : ""}</span>
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
