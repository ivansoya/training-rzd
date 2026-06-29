import { useEffect, useMemo, useState } from "react";
import ParamControl from "./ParamControl";
import {
  createConfig,
  deleteConfig,
  listConfigs,
  previewConfig,
  updateConfig,
} from "../api";
import type {
  AugConfig,
  DatasetSummary,
  PreviewResult,
  TransformInstance,
  TransformSchema,
} from "../types";

interface Props {
  registry: TransformSchema[];
  available: boolean;
  datasets: DatasetSummary[];
  onBack: () => void;
}

function defaultParams(schema: TransformSchema): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const p of schema.params) {
    if (p.default !== undefined && p.default !== null) params[p.name] = p.default;
  }
  return params;
}

export default function AugmentView({ registry, available, datasets, onBack }: Props) {
  const uploaded = datasets.filter((d) => d.kind === "uploaded");
  const [configs, setConfigs] = useState<AugConfig[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [builtin, setBuiltin] = useState(false);
  const [name, setName] = useState("Новая конфигурация");
  const [transforms, setTransforms] = useState<TransformInstance[]>([]);
  const [addName, setAddName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [previewSource, setPreviewSource] = useState(uploaded[0]?.name ?? "");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const registryByName = useMemo(
    () => Object.fromEntries(registry.map((t) => [t.name, t])),
    [registry]
  );

  async function reloadConfigs(selectId?: string) {
    const list = await listConfigs();
    setConfigs(list);
    if (selectId) selectConfig(list.find((c) => c.id === selectId) ?? null);
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
    setError(null);
  }

  function addTransform() {
    const schema = registryByName[addName];
    if (!schema) return;
    setTransforms((t) => [...t, { name: schema.name, params: defaultParams(schema) }]);
    setAddName("");
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
    setBusy(true);
    setError(null);
    try {
      if (editId && !builtin) {
        await updateConfig(editId, name.trim(), transforms);
        await reloadConfigs(editId);
      } else {
        const created = await createConfig(name.trim(), transforms);
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
      newConfig();
      await reloadConfigs();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    if (!previewSource) {
      setPreviewErr("Нет загруженных датасетов для превью");
      return;
    }
    setPreviewBusy(true);
    setPreviewErr(null);
    try {
      setPreview(await previewConfig(previewSource, transforms));
    } catch (e) {
      setPreviewErr((e as Error).message);
      setPreview(null);
    } finally {
      setPreviewBusy(false);
    }
  }

  return (
    <div className="augment-view">
      <div className="aug-bar">
        <button className="btn" onClick={onBack}>
          Назад к датасетам
        </button>
        <h2>Конфигурации аугментаций</h2>
      </div>

      {!available && (
        <div className="warn-banner">
          ⚠ Библиотека albumentations недоступна на сервере — превью и генерация
          отключены.
        </div>
      )}
      {error && <div className="error-banner inline">{error}</div>}

      <div className="aug-layout">
        {/* configs list */}
        <div className="aug-col aug-configs">
          <button className="btn btn-primary block" onClick={newConfig}>
            Новая конфигурация
          </button>
          <ul className="config-list">
            {configs.map((c) => (
              <li
                key={c.id}
                className={c.id === editId ? "config-item active" : "config-item"}
                onClick={() => selectConfig(c)}
              >
                <span>{c.name}</span>
                <span className="count">{c.transforms.length}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* editor */}
        <div className="aug-col aug-editor">
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
            <p className="subtle">Базовую конфигурацию нельзя изменить или удалить.</p>
          )}

          <div className="add-row">
            <select
              className="text-input"
              value={addName}
              disabled={builtin}
              onChange={(e) => setAddName(e.target.value)}
            >
              <option value="">— добавить аугментацию —</option>
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
              className="btn"
              onClick={addTransform}
              disabled={builtin || !addName}
            >
              Добавить
            </button>
          </div>

          <div className="transform-list">
            {transforms.length === 0 && (
              <p className="subtle">Аугментаций нет — это эквивалент базовой конфигурации.</p>
            )}
            {transforms.map((inst, idx) => {
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
              <button className="btn btn-danger" onClick={removeConfig} disabled={busy}>
                Удалить
              </button>
            )}
          </div>
        </div>

        {/* preview */}
        <div className="aug-col aug-preview">
          <div className="preview-controls">
            <select
              className="text-input"
              value={previewSource}
              onChange={(e) => setPreviewSource(e.target.value)}
            >
              {uploaded.length === 0 && <option value="">нет датасетов</option>}
              {uploaded.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              onClick={runPreview}
              disabled={!available || previewBusy || !previewSource}
            >
              {previewBusy ? "…" : "Превью"}
            </button>
          </div>

          {previewErr && <div className="error-banner inline">{previewErr}</div>}
          {preview && (
            <div className="preview-images">
              <figure>
                <figcaption>Оригинал</figcaption>
                <img src={preview.original} alt="original" />
              </figure>
              <figure>
                <figcaption>После аугментаций</figcaption>
                <img src={preview.augmented} alt="augmented" />
              </figure>
              <p className="subtle mono">{preview.image}</p>
            </div>
          )}
          {!preview && !previewErr && (
            <p className="subtle">
              Выберите датасет и нажмите «Превью» — случайное изображение пройдёт через
              текущие аугментации.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
