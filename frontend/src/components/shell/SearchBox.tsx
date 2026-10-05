import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getProject, listTasks } from "../../auth/api";
import type { ProjectMembership } from "../../auth/api";
import { listRuns } from "../../api/runs";
import { listSets } from "../../api/trainsets";
import { projectImages } from "../../api/gallery";
import { Icon, Input, cx, useEscape } from "../../ui";
import { PROJECT_GROUPS, hrefOf } from "./nav";
import { searchItems } from "./search";
import type { SearchItem } from "./search";

/** Поиск по разделам, проектам и содержимому текущего проекта. Ctrl K — в поле. */
export default function SearchBox({ projects, project }: {
  projects: ProjectMembership[];
  project: ProjectMembership | undefined;
}) {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [content, setContent] = useState<{ code: string; items: SearchItem[] } | null>(null);
  const loading = useRef<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "л" || e.code === "KeyK")) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Содержимое проекта — при первом фокусе, а не на каждой странице
  async function loadProject() {
    const code = project?.code;
    if (!code || content?.code === code || loading.current === code) return;
    loading.current = code;
    const base = `/projects/${code}`;
    const [detail, tasks, sets, runs] = await Promise.allSettled([
      getProject(code), listTasks(code), listSets(code), listRuns(code),
    ]);
    const items: SearchItem[] = [];
    if (tasks.status === "fulfilled") {
      for (const t of tasks.value.tasks) {
        items.push({ group: "Таски", label: t.name, hint: t.status_label, to: `${base}/tasks/${t.id}`, icon: "check" });
      }
    }
    if (detail.status === "fulfilled") {
      for (const c of detail.value.classes) {
        items.push({ group: "Классы", label: c.name, hint: c.superclass ?? undefined, to: `${base}/classes`, icon: "tag" });
      }
      for (const d of detail.value.datasets) {
        items.push({ group: "Датасеты", label: d.name, to: `${base}/datasets?ds=${d.id}`, icon: "images" });
      }
    }
    if (sets.status === "fulfilled") {
      for (const s of sets.value.sets) {
        items.push({ group: "Наборы", label: s.name, to: `${base}/trainsets/${s.id}`, icon: "layers" });
      }
    }
    if (runs.status === "fulfilled") {
      for (const r of runs.value.runs) {
        items.push({ group: "Обучения", label: r.number ? `№${r.number} · ${r.name}` : r.name, hint: r.base_model, to: `${base}/runs/${r.number ?? r.id}`, icon: "activity" });
      }
    }
    loading.current = null;
    setContent({ code, items });
  }

  // Кадры ищутся на сервере по имени файла — их слишком много, чтобы держать списком
  const [frames, setFrames] = useState<{ key: string; items: SearchItem[] } | null>(null);
  useEffect(() => {
    const code = project?.code;
    const term = q.trim();
    if (!code || term.length < 2) return;
    let alive = true;
    const h = window.setTimeout(() => {
      projectImages(code, { q: term, limit: 5 }).then((r) => {
        if (!alive) return;
        setFrames({
          key: `${code}|${term}`,
          items: r.images.map((im) => ({
            group: "Кадры", label: im.file_name, hint: im.dataset_name,
            to: `/projects/${code}/datasets?frame=${im.id}`, icon: "image" as const,
          })),
        });
      }).catch(() => {});
    }, 250);
    return () => { alive = false; window.clearTimeout(h); };
  }, [q, project?.code]);

  const all = useMemo(() => {
    const items: SearchItem[] = [];
    if (project) {
      for (const g of PROJECT_GROUPS) {
        for (const it of g.items) {
          items.push({ group: "Разделы", label: it.label, to: hrefOf(it, project.code), icon: it.icon });
        }
      }
    }
    items.push(
      { group: "Разделы", label: "Все проекты", to: "/", icon: "folder" },
      { group: "Разделы", label: "Мои графы", to: "/augment", icon: "workflow" },
      { group: "Разделы", label: "Оборудование", to: "/hardware", icon: "cpu" },
      { group: "Разделы", label: "Личный кабинет", to: "/account", icon: "user" },
    );
    for (const p of projects) {
      items.push({ group: "Проекты", label: p.name, hint: p.code, to: `/projects/${p.code}`, icon: "folder" });
    }
    if (content && content.code === project?.code) items.push(...content.items);
    if (frames && frames.key === `${project?.code}|${q.trim()}`) items.push(...frames.items);
    return items;
  }, [projects, project, content, frames, q]);

  const found = useMemo(() => searchItems(q, all), [q, all]);
  const shown = open && q.trim().length > 0;
  useEscape(() => { setOpen(false); setQ(""); input.current?.blur(); }, shown);
  useEffect(() => setCursor(0), [q]);

  function go(item: SearchItem) {
    setOpen(false);
    setQ("");
    input.current?.blur();
    navigate(item.to);
  }

  return (
    <div className="search" onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
    }}>
      <Input ref={input} icon="search" kbd="Ctrl K" placeholder="Таска, класс, кадр" value={q}
        aria-label="Поиск" role="combobox" aria-expanded={shown}
        aria-controls="search-results" aria-autocomplete="list"
        onFocus={() => { setOpen(true); void loadProject(); }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(found.length - 1, c + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
          else if (e.key === "Enter" && found[cursor]) { e.preventDefault(); go(found[cursor]); }
          else if (e.key === "Escape") { setQ(""); input.current?.blur(); }
        }} />
      {shown && (
        <div className="ui-pop search-pop" id="search-results" role="listbox">
          {found.length === 0 ? (
            <div className="search-none">Ничего не нашлось{project && !content ? " — загружаю проект…" : ""}</div>
          ) : found.map((it, i) => (
            <div key={`${it.group}:${it.to}:${it.label}`}>
              {(i === 0 || found[i - 1].group !== it.group) && <div className="ui-pop-h">{it.group}</div>}
              <button type="button" role="option" aria-selected={i === cursor} tabIndex={-1}
                className={cx("ui-opt", i === cursor && "on")}
                onMouseEnter={() => setCursor(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => go(it)}>
                <Icon name={it.icon} size={14} />
                <span className="ui-opt-t">{it.label}{it.hint && <span className="ui-opt-h">{it.hint}</span>}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
