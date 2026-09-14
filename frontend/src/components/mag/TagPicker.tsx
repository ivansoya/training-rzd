import { useEffect, useMemo, useRef, useState } from "react";
import type { Tag } from "../../api/tags";
import { createTag } from "../../api/tags";

/** Чипы тагов: показать, снять, добавить, завести новый.
 *
 * Один компонент на три места — карточка ролика, карточка загрузки и редактор
 * разметки, — потому что вопрос там один и тот же: «в каких условиях снят этот
 * материал». Три отдельные реализации разошлись бы на первой же правке, а
 * человек увидел бы три разных способа поставить один и тот же таг.
 *
 * Новый таг заводится прямо отсюда: разметчик встречает «тоннель» посреди
 * работы, и уход в настройки проекта за справочником стоил бы потерянного
 * места в ролике. Справочник от этого не зарастает — имя нормализуется на
 * сервере, и повтор возвращает существующий таг, а не заводит второй.
 */
export default function TagPicker({
  code,
  all,
  value,
  onChange,
  onCreated,
  disabled,
  compact,
  placeholder = "добавить таг",
}: {
  /** Код проекта — нужен, чтобы завести таг на месте. */
  code: string;
  /** Справочник проекта. */
  all: Tag[];
  /** Что стоит сейчас. */
  value: string[];
  onChange: (next: string[]) => void;
  /** Заведённый на месте таг — чтобы владелец списка дописал его в справочник. */
  onCreated?: (tag: Tag) => void;
  disabled?: boolean;
  compact?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // Закрываем по нажатию мыши мимо, а не по отпусканию: отпускание приходит и
  // после протяжки выделения изнутри меню наружу — меню захлопывалось ровно в
  // тот момент, когда человек выделял набранное имя тага.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);
  const picked = value.map((id) => byId.get(id)).filter(Boolean) as Tag[];
  const needle = query.trim().toLowerCase();
  const offer = all.filter(
    (t) => !value.includes(t.id) && (!needle || t.name.toLowerCase().includes(needle))
  );
  // Точное совпадение — это выбор существующего, а не повод заводить второй.
  const exact = all.some((t) => t.name.toLowerCase() === needle);

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  }

  async function create() {
    const name = query.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const tag = await createTag(code, name);
      onCreated?.(tag);
      if (!value.includes(tag.id)) onChange([...value, tag.id]);
      setQuery("");
      input.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`tagp${compact ? " tagp-compact" : ""}`} ref={root}>
      <div className="tagp-row">
        {picked.map((tag) => (
          <span key={tag.id} className="tagp-chip on">
            {tag.name}
            {!disabled && (
              <button
                type="button"
                className="tagp-x"
                onClick={() => toggle(tag.id)}
                aria-label={`снять таг «${tag.name}»`}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <button
            type="button"
            className="tagp-chip tagp-add"
            onClick={() => {
              setOpen((v) => !v);
              window.setTimeout(() => input.current?.focus(), 0);
            }}
          >
            + {placeholder}
          </button>
        )}
        {disabled && !picked.length && <span className="tagp-none">без тагов</span>}
      </div>

      {open && !disabled && (
        <div className="tagp-menu">
          <input
            ref={input}
            className="tagp-search"
            value={query}
            placeholder="найти или завести"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter") {
                e.preventDefault();
                // Точное совпадение выбираем, остальное заводим. Иначе
                // «ночь», набранное при уже существующем таге, породило бы
                // второй такой же — ровно то, ради чего справочник и завели.
                const hit = all.find((t) => t.name.toLowerCase() === needle);
                if (hit) toggle(hit.id);
                else void create();
              }
            }}
          />
          <div className="tagp-list">
            {offer.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="tagp-item"
                onClick={() => toggle(tag.id)}
              >
                {tag.name}
                {tag.images !== undefined && <span>{tag.images}</span>}
              </button>
            ))}
            {!offer.length && !needle && (
              <span className="tagp-empty">В проекте пока нет тагов.</span>
            )}
            {needle && !exact && (
              <button
                type="button"
                className="tagp-item tagp-new"
                onClick={() => void create()}
                disabled={busy}
              >
                Завести таг «{query.trim()}»
              </button>
            )}
          </div>
          {error && <div className="tagp-error">{error}</div>}
        </div>
      )}
    </div>
  );
}

/** Только показать. Галерея и списки не правят таги — правка живёт в
 *  редакторе разметки, по одному кадру. */
export function TagChips({ all, value }: { all: Tag[]; value: string[] }) {
  const byId = new Map(all.map((t) => [t.id, t]));
  const names = value.map((id) => byId.get(id)?.name).filter(Boolean);
  if (!names.length) return null;
  return (
    <span className="tagp-row tagp-flat">
      {names.map((name) => (
        <span key={name} className="tagp-chip on">
          {name}
        </span>
      ))}
    </span>
  );
}
