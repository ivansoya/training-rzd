import { useState } from "react";
import type { DatasetKind, DatasetStats } from "../../types";

interface Props {
  stats: DatasetStats | null;
  kind: DatasetKind | null;
  loading: boolean;
  onAugment: () => void;
  onBack: () => void;
  onRename: (displayName: string) => Promise<void> | void;
}

export default function DatasetStatsView({
  stats,
  kind,
  loading,
  onAugment,
  onBack,
  onRename,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  if (loading) {
    return <section className="content empty-state">Загрузка статистики…</section>;
  }
  if (!stats) {
    return (
      <section className="content empty-state">
        Выберите датасет, чтобы увидеть статистику
      </section>
    );
  }

  const maxInstances = Math.max(1, ...stats.classes.map((c) => c.instances));
  const totalInstances = Math.max(1, stats.total_instances);
  const display = stats.display_name || stats.meta?.display_name || stats.name;

  async function commitRename() {
    const v = draft.trim();
    if (!v || v === display) {
      setEditing(false);
      return;
    }
    setRenaming(true);
    try {
      await onRename(v);
      setEditing(false);
    } finally {
      setRenaming(false);
    }
  }

  return (
    <section className="content">
      <button className="back-btn" onClick={onBack} title="К списку датасетов">
        <span className="back-ico">←</span> Назад
      </button>
      <div className="stats-head">
        <div>
          {editing ? (
            <div className="rename-row">
              <input
                className="text-input stats-title-input"
                autoFocus
                value={draft}
                disabled={renaming}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setEditing(false);
                }}
              />
              <button
                className="btn btn-primary"
                onClick={commitRename}
                disabled={renaming || !draft.trim()}
              >
                {renaming ? "…" : "Сохранить"}
              </button>
              <button
                className="btn"
                onClick={() => setEditing(false)}
                disabled={renaming}
              >
                Отмена
              </button>
            </div>
          ) : (
            <div className="title-row">
              <h2 className="stats-title">{display}</h2>
              <button
                className="icon-btn rename-btn"
                title="Переименовать"
                onClick={() => {
                  setDraft(display);
                  setEditing(true);
                }}
              >
                ✎
              </button>
            </div>
          )}
          {kind === "augmented" && stats.meta && (
            <p className="subtle">
              из «{stats.meta.source_name || stats.meta.source}» ·{" "}
              {stats.meta.configs.length}{" "}
              {stats.meta.configs.length === 1 ? "проход" : "прохода/проходов"}
              {stats.meta.scope === "train" ? " · только train" : " · все изображения"}
            </p>
          )}
        </div>
        {kind === "uploaded" && (
          <button className="btn btn-primary" onClick={onAugment}>
            Создать аугментацию
          </button>
        )}
      </div>

      {kind === "augmented" && stats.meta && (
        <div className="applied-configs">
          <h3 className="section-title">Применённые конфигурации</h3>
          {stats.meta.configs.map((cfg, i) => (
            <div className="applied-config" key={i}>
              <div className="applied-config-head">
                <span className="badge">проход {i + 1}</span>
                <span className="applied-config-name">{cfg.name}</span>
              </div>
              {cfg.transforms.length === 0 ? (
                <span className="subtle">без аугментаций (копия)</span>
              ) : (
                <div className="chips">
                  {cfg.transforms.map((t, j) => (
                    <span className="chip" key={j} title={JSON.stringify(t.params)}>
                      {t.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="cards">
        <Card label="Изображений" value={stats.total_images} />
        <Card label="Файлов разметки" value={stats.total_label_files} />
        <Card label="Объектов (instances)" value={stats.total_instances} />
        <Card label="Классов (nc)" value={stats.nc} />
      </div>

      {stats.unknown_class_instances > 0 && (
        <div className="warn-banner">
          ⚠ Объектов с неизвестным классом: {stats.unknown_class_instances}
        </div>
      )}
      {stats.warnings && stats.warnings.length > 0 && (
        <div className="warn-banner">
          ⚠ Предупреждения при валидации ({stats.warnings.length}):
          <ul>
            {stats.warnings.slice(0, 10).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="section-title">Разбиения (splits)</h3>
      <table className="stats-table">
        <thead>
          <tr>
            <th>Split</th>
            <th>Изображений</th>
            <th>С разметкой</th>
            <th>Фон (пустые)</th>
            <th>Объектов</th>
          </tr>
        </thead>
        <tbody>
          {stats.splits.map((s) => (
            <tr key={s.split}>
              <td className="mono">{s.split}</td>
              <td>{s.images}</td>
              <td>{s.labeled}</td>
              <td>{s.background}</td>
              <td>{s.instances}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="section-title">Распределение по классам</h3>
      <table className="stats-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Класс</th>
            <th>Объектов</th>
            <th>Изображений</th>
            <th>Доля</th>
          </tr>
        </thead>
        <tbody>
          {stats.classes.map((c) => (
            <tr key={c.id}>
              <td className="mono">{c.id}</td>
              <td>{c.name}</td>
              <td>{c.instances}</td>
              <td>{c.images}</td>
              <td className="bar-cell">
                <div className="share-bar">
                  <div className="bar-wrap">
                    <div
                      className="bar"
                      style={{ width: `${(c.instances / maxInstances) * 100}%` }}
                    />
                  </div>
                  <span className="share-tip">
                    {((c.instances / totalInstances) * 100).toFixed(1)}% от всех
                    объектов
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="card-value">{value.toLocaleString("ru-RU")}</div>
      <div className="card-label">{label}</div>
    </div>
  );
}
