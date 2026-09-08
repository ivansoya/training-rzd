// Запуск обучения: модель и гиперпараметры.
//
// Модели показываются только под задачу набора. Набор рамок и сегментационная
// модель — несовместимая пара, и выбрать её должно быть невозможно, а не
// «можно, но потом не обучится».
//
// Умолчания и пределы полей приходят с сервера (`/api/models` → `params`):
// это та же спецификация, по которой он проверяет запрос. Своих чисел форма
// не держит — иначе они разойдутся на первой же правке.
//
// Аугментации — либо графа, либо YOLO. Набор из графа уже искажён на диске,
// и ручек YOLO у него нет вовсе: показать их значило бы обещать то, что
// сервер всё равно выключит.

import { useEffect, useMemo, useState } from "react";
import * as runsApi from "../../api/runs";
import type { ModelRow, ParamSpec, ParamValue } from "../../api/runs";
import type { TrainSet } from "../../api/trainsets";

const TASK_OF: Record<string, "detect" | "segment"> = {
  bbox: "detect",
  polygon: "segment",
};

const ru = (n: number) => Math.round(n).toLocaleString("ru-RU");

// Подписи полей — словами. Ключ ultralytics в скобках там, где он общеизвестен
// и человек будет искать его в документации.
const LABEL: Record<string, string> = {
  epochs: "Эпох",
  imgsz: "Размер входа",
  batch: "Батч",
  patience: "Стоп без улучшения, эпох",
  optimizer: "Оптимизатор",
  lr0: "Скорость обучения (lr0)",
  lrf: "Конечная доля скорости (lrf)",
  momentum: "Момент",
  weight_decay: "Затухание весов",
  warmup_epochs: "Разогрев, эпох",
  cos_lr: "Косинусный график скорости",
  freeze: "Заморозить первых слоёв",
  dropout: "Dropout",
  label_smoothing: "Сглаживание меток",
  seed: "Зерно",
  workers: "Загрузчиков данных",
  hsv_h: "Тон (hsv_h)",
  hsv_s: "Насыщенность (hsv_s)",
  hsv_v: "Яркость (hsv_v)",
  degrees: "Поворот, °",
  translate: "Сдвиг, доля",
  scale: "Масштаб, ±доля",
  shear: "Скос, °",
  perspective: "Перспектива",
  flipud: "Отражение по вертикали, p",
  fliplr: "Отражение по горизонтали, p",
  bgr: "Перестановка каналов, p",
  mosaic: "Мозаика, p",
  mixup: "Mixup, p",
  copy_paste: "Copy-paste, p",
  close_mosaic: "Без мозаики последние N эпох",
};

const OPTIM = ["optimizer", "lr0", "lrf", "momentum", "weight_decay", "warmup_epochs", "cos_lr"];
const REG = ["freeze", "dropout", "label_smoothing"];
const MISC = ["seed", "workers"];
const AUG = [
  "mosaic", "close_mosaic", "fliplr", "flipud", "scale", "translate",
  "degrees", "shear", "perspective", "hsv_h", "hsv_s", "hsv_v", "mixup",
  "copy_paste", "bgr",
];

function stepOf(spec: ParamSpec): number | "any" {
  if (spec.step) return spec.step;
  if (spec.type === "int") return 1;
  return "any";
}

export default function StartRunModal({
  code,
  set,
  onClose,
  onStarted,
}: {
  code: string;
  set: TrainSet;
  onClose: () => void;
  onStarted: () => void;
}) {
  const task = TASK_OF[set.kind] ?? "detect";
  const [models, setModels] = useState<ModelRow[]>([]);
  const [spec, setSpec] = useState<Record<string, ParamSpec>>({});
  const [augDefaults, setAugDefaults] = useState<Record<string, number>>({});
  const [model, setModel] = useState("");
  const [values, setValues] = useState<Record<string, ParamValue>>({});
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    runsApi
      .listModels(task)
      .then((got) => {
        setModels(got.models);
        setSpec(got.params);
        setAugDefaults(got.aug_defaults);
        setModel(got.models[0]?.id ?? "");
        const init: Record<string, ParamValue> = {};
        for (const [key, s] of Object.entries(got.params)) {
          if (s.default !== null && s.default !== undefined) init[key] = s.default;
        }
        setValues(init);
      })
      .catch((e) => setError((e as Error).message));
  }, [task]);

  useEffect(() => {
    if (model) setName(`${set.name} · ${model}`);
  }, [set.name, model]);

  const chosen = useMemo(() => models.find((m) => m.id === model), [models, model]);
  const hasGraph = Boolean(set.graph);
  const augOn = values.augment_mode !== "off";
  const pretrained = values.pretrained !== false;

  const setValue = (key: string, value: ParamValue) =>
    setValues((v) => ({ ...v, [key]: value }));

  const resetAug = () =>
    setValues((v) => ({ ...v, ...augDefaults, augment_mode: "yolo" }));

  const augChanged = AUG.some(
    (k) => values[k] !== undefined && values[k] !== augDefaults[k]
  );

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, ParamValue> = {};
      for (const [key, value] of Object.entries(values)) {
        if (hasGraph && (AUG.includes(key) || key === "augment_mode")) continue;
        if (value === "" || value === null || value === undefined) continue;
        params[key] = value;
      }
      await runsApi.startRun(code, {
        set_id: set.id,
        model,
        name: name.trim(),
        params,
      });
      onStarted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const field = (key: string) => {
    const s = spec[key];
    if (!s) return null;
    const id = `run-${key}`;
    const label = LABEL[key] ?? key;
    if (s.type === "bool") {
      return (
        <label className="t-check" key={key} htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(values[key])}
            onChange={(e) => setValue(key, e.target.checked)}
          />
          {label}
        </label>
      );
    }
    if (s.type === "str" && s.choices) {
      return (
        <div className="mag-field" key={key}>
          <label htmlFor={id}>{label}</label>
          <select
            id={id}
            value={String(values[key] ?? s.default ?? "")}
            onChange={(e) => setValue(key, e.target.value)}
          >
            {s.choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      );
    }
    const current = values[key];
    return (
      <div className="mag-field" key={key}>
        <label htmlFor={id} title={key}>
          {label}
        </label>
        <input
          id={id}
          type="number"
          min={s.min}
          max={s.max}
          step={stepOf(s)}
          value={current === undefined || current === null ? "" : String(current)}
          placeholder={s.default === null || s.default === undefined ? "авто" : undefined}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              setValues((v) => {
                const next = { ...v };
                delete next[key];
                return next;
              });
              return;
            }
            setValue(key, Number(raw));
          }}
        />
      </div>
    );
  };

  return (
    <div className="mag-backdrop" onClick={onClose}>
      <div
        className="mag-modal t-modal-wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Запустить обучение"
      >
        <h1>Обучение на наборе «{set.name}»</h1>
        <p className="mag-sub">
          {set.counts
            ? `${ru(set.counts.samples)} образцов · обучение ${ru(
                set.counts.train
              )} · проверка ${ru(set.counts.val)}`
            : "набор готов"}
          {set.counts?.background ? ` · фона ${ru(set.counts.background)}` : ""}
        </p>

        {error && <div className="mag-error">{error}</div>}

        <div className="mag-field">
          <label htmlFor="run-name">Имя обучения</label>
          <input
            id="run-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="mag-field">
          <label htmlFor="run-model">
            Модель · {task === "segment" ? "сегментация" : "детекция"}, по виду
            набора
          </label>
          <select
            id="run-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.size ? ` · ${m.size}` : ""}
                {m.note ? ` · ${m.note}` : ""}
                {m.builtin ? "" : " · своя"}
              </option>
            ))}
          </select>
        </div>
        {chosen && (
          <div className="t-form-note">
            {chosen.builtin ? (
              <>
                Предобучена на COCO.{" "}
                {chosen.cached
                  ? "Веса уже на томе."
                  : "Весов на томе ещё нет — первый запуск начнёт со скачивания (5–40 МБ с GitHub)."}
              </>
            ) : (
              <>Своя модель: учится от принесённых весов.</>
            )}
          </div>
        )}
        {chosen?.builtin && chosen.scratch && (
          <label className="t-check" htmlFor="run-scratch">
            <input
              id="run-scratch"
              type="checkbox"
              checked={!pretrained}
              onChange={(e) => setValue("pretrained", !e.target.checked)}
            />
            Учить с нуля, без предобученных весов
          </label>
        )}
        {!pretrained && (
          <p className="t-form-hint">
            С нуля сеть начинает со случайных весов. На тысячах кадров одного
            ракурса это даёт заметно хуже, чем дообучение, и переобучается
            раньше — включайте, только если знаете зачем.
          </p>
        )}

        <div className="t-form-section">
          <div className="g-label">Сколько учить</div>
          <div className="t-form-grid">
            {field("epochs")}
            {field("imgsz")}
            {field("batch")}
          </div>
          <p className="t-form-hint">
            Размер входа и батч определяют, сколько нужно видеопамяти. Не хватит
            сейчас — обучение встанет в очередь и скажет, чего именно не хватает;
            не хватит никогда — скажет и это, до запуска.
          </p>
        </div>

        <div className="t-form-section">
          <div className="g-label">Когда остановиться</div>
          <div className="t-form-grid">{field("patience")}</div>
          <p className="t-form-hint">
            Столько эпох подряд без роста качества на проверке — и обучение
            заканчивается, лучшие веса уже сохранены. Ноль — идти до конца.
          </p>
        </div>

        <div className="t-form-section">
          <div className="g-label">Аугментации</div>
          {hasGraph ? (
            <div className="t-form-note">
              Набор собран графом <b>{set.graph?.name}</b> (в{set.graph?.version}):
              искажения уже лежат на диске, и встроенные аугментации YOLO к нему
              не применяются — иначе искажение было бы двойным, а сборка
              перестала бы быть воспроизводимой.
            </div>
          ) : (
            <>
              <label className="t-check" htmlFor="run-aug-on" style={{ marginTop: 0 }}>
                <input
                  id="run-aug-on"
                  type="checkbox"
                  checked={augOn}
                  onChange={(e) => setValue("augment_mode", e.target.checked ? "yolo" : "off")}
                />
                Встроенные аугментации YOLO (рекомендуемые значения ultralytics)
              </label>
              {augOn ? (
                <>
                  <div className="t-form-grid" style={{ marginTop: 10 }}>
                    {AUG.map(field)}
                  </div>
                  <div className="t-form-actions">
                    <p className="t-form-hint" style={{ margin: 0 }}>
                      Значения «p» — вероятность применить к кадру. Мозаика
                      склеивает четыре кадра в один и выключается за последние
                      эпохи, чтобы сеть доучилась на настоящих кадрах.
                    </p>
                    {augChanged && (
                      <button type="button" className="mag-ghost mag-ghost-inline" onClick={resetAug}>
                        Вернуть рекомендуемые
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <p className="t-form-hint">
                  Без аугментаций сеть видит одни и те же кадры сто раз подряд и
                  запоминает их: потери на обучении падают, на проверке растут.
                  Годится только для наборов, размноженных заранее.
                </p>
              )}
            </>
          )}
        </div>

        <details className="t-fold">
          <summary>Тонкая настройка: оптимизатор, регуляризация, зерно</summary>
          <div className="t-form-grid">{OPTIM.map(field)}</div>
          <p className="t-form-hint">
            «auto» подбирает оптимизатор и скорость сам: SGD на долгих
            обучениях, AdamW на коротких. Разогрев — эпохи с малой скоростью в
            начале, чтобы предобученные веса не сорвало первым же шагом.
          </p>
          <div className="t-form-grid" style={{ marginTop: 10 }}>
            {REG.map(field)}
            {MISC.map(field)}
          </div>
          <p className="t-form-hint">
            Заморозка первых слоёв ускоряет дообучение и бережёт признаки
            основы; зерно повторяет перемешивание и аугментации — то же зерно
            даёт то же обучение. Загрузчиков «авто» — по числу ядер.
          </p>
        </details>

        <div className="mag-modal-foot">
          <button type="button" className="mag-ghost" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="mag-btn"
            disabled={busy || !model}
            onClick={start}
          >
            {busy ? "Ставлю в очередь…" : "Запустить"}
          </button>
        </div>
      </div>
    </div>
  );
}
