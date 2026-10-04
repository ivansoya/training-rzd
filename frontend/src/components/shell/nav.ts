import type { IconName } from "../../ui";

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  /** Адрес относительно /projects/<code>, либо абсолютный (начинается с «/»). */
  to: string;
  /** Чьи адреса подсвечивают этот пункт, относительно /projects/<code>. */
  match?: RegExp;
  abs?: boolean;
}

export const PROJECT_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Проект",
    items: [
      { key: "overview", label: "Обзор", icon: "home", to: "", match: /^\/?$/ },
      { key: "datasets", label: "Датасеты", icon: "images", to: "/datasets", match: /^\/datasets(\/|$)/ },
      { key: "tasks", label: "Таски", icon: "check", to: "/tasks", match: /^\/tasks(\/|$)/ },
      { key: "classes", label: "Классы", icon: "tag", to: "/classes", match: /^\/(classes|tags)(\/|$)/ },
      { key: "members", label: "Участники", icon: "users", to: "/members", match: /^\/members(\/|$)/ },
    ],
  },
  {
    title: "Подготовка",
    items: [
      { key: "aug", label: "Аугментации", icon: "workflow", to: "/aug", match: /^\/aug(\/|$)/ },
      { key: "agents", label: "Мои агенты", icon: "sparkle", to: "/agents", abs: true },
    ],
  },
  {
    title: "Обучение",
    items: [
      { key: "sets", label: "Наборы", icon: "layers", to: "/training?tab=sets",
        match: /^\/(training\/?$|training\/new|trainsets\/)/ },
      { key: "runs", label: "Прогоны", icon: "activity", to: "/training?tab=runs",
        match: /^\/training\/runs\// },
    ],
  },
];

/** Разделы вне проекта: имя одно на меню, крошки и вкладку браузера. */
const GLOBAL: [RegExp, string, string][] = [
  [/^\/augment(\/|$)/, "graphs", "Мои графы"],
  [/^\/agents(\/|$)/, "agents", "Мои агенты"],
  [/^\/hardware(\/|$)/, "hardware", "Оборудование"],
  [/^\/account(\/|$)/, "account", "Личный кабинет"],
];

/** Какой пункт меню горит и как назвать раздел. code — проект из адреса, если мы в нём. */
export function sectionOf(pathname: string, search: string, code: string | undefined):
  { key: string; label: string } {
  if (code) {
    const base = "/projects/" + code;
    const rest = pathname.slice(base.length);
    if (pathname.toLowerCase().startsWith(base.toLowerCase())) {
      if (/^\/import\/?$/.test(rest)) return { key: "overview", label: "Импорт" };
      if (/^\/tags(\/|$)/.test(rest)) return { key: "classes", label: "Таги" };
      // Наборы и прогоны — одна страница, раздел выбирает ?tab
      if (/^\/training\/?$/.test(rest) && new URLSearchParams(search).get("tab") === "runs") {
        return { key: "runs", label: "Прогоны" };
      }
      for (const g of PROJECT_GROUPS) {
        for (const it of g.items) {
          if (it.match && it.match.test(rest)) return { key: it.key, label: it.label };
        }
      }
      return { key: "overview", label: "Обзор" };
    }
  }
  for (const [re, key, label] of GLOBAL) if (re.test(pathname)) return { key, label };
  return { key: "projects", label: "Все проекты" };
}

export function hrefOf(item: NavItem, code: string): string {
  return item.abs ? item.to : "/projects/" + code + item.to;
}
