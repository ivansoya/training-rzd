import { useEffect, useMemo, useState } from "react";
import ParamControl from "./ParamControl";
import {
  createConfig,
  deleteConfig,
  listConfigs,
  previewConfig,
  updateConfig,
} from "../../api";
import type {
  AugConfig,
  DatasetSummary,
  PreviewResult,
  TransformInstance,
  TransformSchema,
} from "../../types";

interface Props {
  registry: TransformSchema[];
  available: boolean;
  datasets: DatasetSummary[];
}

function defaultParams(schema: TransformSchema): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const p of schema.params) {
    if (p.default !== undefined && p.default !== null) params[p.name] = p.default;
  }
  return params;
}

export default function AugmentView({ registry, available, datasets }: Props) {
  const uploaded = datasets.filter((d) => d.kind === "uploaded");
  const [configs, setConfigs] = useState<AugConfig[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [builtin, setBuiltin] = useState(false);
  const [name, setName] = useState("Новая конфигурация");
  const [transforms, setTransforms] = useState<TransformInstance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [previewSource, setPreviewSource] = useState(uploaded[0]?.name ?? "");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  // Seed fixes WHICH image is sampled, so tweaking params re-augments the same
  // picture; "Другое изображение" just rolls a new seed. The slider position is
  // kept across updates so the chosen side stays revealed.
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [sliderPos, setSliderPos] = useState(50);

  const registryByName = useMemo(
    () => Object.fromEntries(registry.map((t) => [t.name, t])),
    [registry]
  );

  async function reloadConfigs(selectId?: string) {
    const list = await listConfigs();
    setConfigs(list);
    if (selectId) {
      const found = list.find((c) => c.id === selectId);
      if (found) pickConfig(found);
    }
  }

  useEffect(() => {
    reloadConfigs();
  }, []);

  useEffect(() => {
    if (!previewSource && uploaded[0]) setPreviewSource(uploaded[0].name);
  }, [datasets]); // eslint-disable-line react-hooks/exhaustive-deps

  function selectConfig(c: AugConfig | null) {
    if (!c) {
      setEditId(null);
      setBuiltin(false);
      setName("Новая конфигурация");
      setTransforms([]);
      return;
    }
    setEditId(c.id);
    setBuiltin(Boolean(c.builtin));
    setName(c.name);
    setTransforms(c.transforms.map((t) => ({ name: t.name, params: { ...t.params } })));
  }

  function newConfig() {
    selectConfig(null);
    setCreating(true);
    setError(null);
  }

  function pickConfig(c: AugConfig) {
    selectConfig(c);
    setCreating(false);
    setError(null);
  }

  function clearSelection() {
    selectConfig(null);
    setCreating(false);
  }

  function addTransform() {
    // New flow: drop in an empty slot first; the user then picks the
    // augmentation inside it. An unpicked slot is "incomplete" and is dropped
    // on save/preview.
    setTransforms((t) => [...t, { name: "", params: {} }]);
  }

  function chooseTransform(idx: number, transformName: string) {
    const schema = registryByName[transformName];
    if (!schema) return;
    setTransforms((t) =>
      t.map((inst, i) =>
        i === idx ? { name: schema.name, params: defaultParams(schema) } : inst
      )
    );
  }

  function removeTransform(idx: number) {
    setTransforms((t) => t.filter((_, i) => i !== idx));
  }

  function setParam(idx: number, key: string, value: unknown) {
    setTransforms((t) =>
      t.map((inst, i) =>
        i === idx ? { ...inst, params: { ...inst.params, [key]: value } } : inst
      )
    );
  }

  async function save() {
    // Only completed augmentations (those with a chosen transform) are saved.
    const clean = transforms.filter((t) => t.name);
    setBusy(true);
    setError(null);
    try {
      if (editId && !builtin) {
        await updateConfig(editId, name.trim(), clean);
        await reloadConfigs(editId);
      } else {
        const created = await createConfig(name.trim(), clean);
        await reloadConfigs(created.id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeConfig() {
    if (!editId || builtin) return;
    if (!window.confirm(`Удалить конфигурацию «${name}»?`)) return;
    setBusy(true);
    try {
      await deleteConfig(editId);
      clearSelection();
      await reloadConfigs();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const active = editId !== null || creating;

  // Live preview: re-runs (debounced) whenever the augmentation set, the source
  // dataset or the seed changes — no manual "Превью" button.
  const completed = transforms.filter((t) => t.name);
  const completedKey = JSON.stringify(completed);
  useEffect(() => {
    if (!available || !previewSource) return;
    let cancelled = false;
    const h = setTimeout(async () => {
      setPreviewBusy(true);
      setPreviewErr(null);
      try {
        const r = await previewConfig(previewSource, JSON.parse(completedKey), seed);
        if (!cancelled) setPreview(r);
      } catch (e) {
        // Keep the last good preview on screen; just surface the error note so
        // the images don't vanish on a transient/invalid-params failure.
        if (!cancelled) setPreviewErr((e as Error).message);
      } finally {
        if (!cancelled) setPreviewBusy(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [available, previewSource, seed, completedKey]);

  function shuffleImage() {
    setSeed(Math.floor(Math.random() * 1e9));
  }

  return (
    <div className="augment-view">
      {!available && (
        <div className="warn-banner">
          ⚠ Библиотека albumentations недоступна на сервере — превью и генерация
          отключены.
        </div>
      )}
      {error && <div className="error-banner inline">{error}</div>}

      <div className="aug-layout">
        {/* left: config list + "new" action (one block), then the editor below */}
        <div className="aug-left">
          <div className="aug-col aug-configs">
            <ul className="config-list">
              {configs.map((c) => (
                <li
                  key={c.id}
                  className={c.id === editId ? "config-item active" : "config-item"}
                  onClick={() => pickConfig(c)}
                >
                  <span>{c.name}</span>
                  <span className="count">{c.transforms.length}</span>
                </li>
              ))}
            </ul>
            <button
              className="btn btn-primary block aug-new-btn"
              onClick={newConfig}
            >
              + Новая конфигурация
            </button>
          </div>

          <div className="aug-col aug-editor">
            {!active ? (
              <p className="subtle empty-hint">
                Выберите конфигурацию из списка или создайте новую.
              </p>
            ) : (
              <>
              <label className="modal-label">
                Название конфигурации
                <input
                  className="text-input"
                  value={name}
                  disabled={builtin}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {builtin && (
                <p className="subtle">
                  Базовую конфигурацию нельзя изменить или удалить.
                </p>
              )}

              <button
                className="btn add-aug-btn"
                onClick={addTransform}
                disabled={builtin}
              >
                + Добавить аугментацию
              </button>

              <div className="transform-list">
                {transforms.length === 0 && (
                  <p className="subtle">
                    Аугментаций нет — это эквивалент базовой конфигурации.
                  </p>
                )}
                {transforms.map((inst, idx) => {
                  // Incomplete slot: the user must still pick an augmentation.
                  if (!inst.name) {
                    return (
                      <div className="transform-card pending" key={`pending-${idx}`}>
                        <div className="transform-head">
                          <select
                            className="text-input"
                            value=""
                            onChange={(e) => chooseTransform(idx, e.target.value)}
                          >
                            <option value="">— выберите аугментацию —</option>
                            <optgroup label="Геометрические">
                              {registry
                                .filter((t) => t.category === "spatial")
                                .map((t) => (
                                  <option key={t.name} value={t.name}>
                                    {t.name}
                                  </option>
                                ))}
                            </optgroup>
                            <optgroup label="Пиксельные">
                              {registry
                                .filter((t) => t.category === "pixel")
                                .map((t) => (
                                  <option key={t.name} value={t.name}>
                                    {t.name}
                                  </option>
                                ))}
                            </optgroup>
                          </select>
                          <button
                            className="del-btn"
                            onClick={() => removeTransform(idx)}
                          >
                            ✕
                          </button>
                        </div>
                        <p className="subtle">
                          Аугментация не выбрана — операция не завершена.
                        </p>
                      </div>
                    );
                  }
                  const schema = registryByName[inst.name];
                  return (
                    <div className="transform-card" key={`${inst.name}-${idx}`}>
                      <div className="transform-head">
                        <span className="transform-title">{inst.name}</span>
                        <button
                          className="del-btn"
                          onClick={() => removeTransform(idx)}
                          disabled={builtin}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="param-grid">
                        {schema?.params.map((p) => (
                          <ParamControl
                            key={p.name}
                            schema={p}
                            value={inst.params[p.name]}
                            onChange={(v) => setParam(idx, p.name, v)}
                          />
                        ))}
                        {!schema && (
                          <p className="subtle">
                            Аугментация недоступна в текущей версии albumentations.
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="editor-actions">
                <button
                  className="btn btn-primary"
                  onClick={save}
                  disabled={busy || builtin || !name.trim()}
                >
                  {editId && !builtin ? "Сохранить" : "Создать конфигурацию"}
                </button>
                {editId && !builtin && (
                  <button
                    className="btn btn-danger"
                    onClick={removeConfig}
                    disabled={busy}
                  >
                    Удалить
                  </button>
                )}
              </div>

              </>
            )}
          </div>
        </div>

        {/* right: live before/after preview with a draggable comparison slider */}
        <div className="aug-col aug-preview-col">
          <div className="preview-head">
            <select
              className="text-input"
              value={previewSource}
              onChange={(e) => setPreviewSource(e.target.value)}
            >
              {uploaded.length === 0 && <option value="">нет датасетов</option>}
              {uploaded.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.display_name || d.name}
                </option>
              ))}
            </select>
            <button
              className="btn"
              onClick={shuffleImage}
              disabled={!available || previewBusy || !previewSource}
              title="Показать другое изображение"
            >
              Другое изображение
            </button>
          </div>

          {!available ? (
            <p className="subtle empty-hint">Превью недоступно.</p>
          ) : !previewSource ? (
            <p className="subtle empty-hint">Нет загруженных датасетов для превью.</p>
          ) : preview ? (
            <>
              {previewErr && (
                <div className="error-banner inline">{previewErr}</div>
              )}
              <div className={previewBusy ? "ba-compare busy" : "ba-compare"}>
                <img
                  className="ba-img"
                  src={preview.augmented}
                  alt="augmented"
                  draggable={false}
                />
                <img
                  className="ba-img ba-top"
                  src={preview.original}
                  alt="original"
                  draggable={false}
                  style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
                />
                <div className="ba-divider" style={{ left: `${sliderPos}%` }} />
                <span className="ba-tag ba-tag-l">Оригинал</span>
                <span className="ba-tag ba-tag-r">Аугментация</span>
                <input
                  className="ba-range"
                  type="range"
                  min={0}
                  max={100}
                  value={sliderPos}
                  onChange={(e) => setSliderPos(Number(e.target.value))}
                  aria-label="Сравнение до и после"
                />
              </div>
              <p className="subtle mono">{preview.image}</p>
              <p className="subtle">
                Тяните ползунок: слева — оригинал, справа — после аугментаций.
                Превью обновляется автоматически.
              </p>
            </>
          ) : previewErr ? (
            <div className="error-banner inline">{previewErr}</div>
          ) : (
            <p className="subtle empty-hint">Загрузка превью…</p>
          )}
        </div>
      </div>
    </div>
  );
}
