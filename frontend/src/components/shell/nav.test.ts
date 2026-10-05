import { describe, expect, it } from "vitest";
import { sectionOf } from "./nav";

const at = (path: string, search = "", code: string | undefined = "VKZ") => sectionOf(path, search, code);

describe("sectionOf", () => {
  it("обзор — корень проекта и импорт", () => {
    expect(at("/projects/VKZ")).toEqual({ key: "overview", label: "Обзор" });
    expect(at("/projects/VKZ/")).toEqual({ key: "overview", label: "Обзор" });
    expect(at("/projects/VKZ/import").label).toBe("Импорт");
  });

  it("вложенные страницы подсвечивают свой раздел", () => {
    expect(at("/projects/VKZ/datasets/abc").key).toBe("datasets");
    expect(at("/projects/VKZ/tasks/t1").key).toBe("tasks");
    expect(at("/projects/VKZ/tags")).toEqual({ key: "classes", label: "Таги" });
  });

  it("наборы на /training, прогоны на /runs; старые адреса прогонов узнаются", () => {
    expect(at("/projects/VKZ/training").key).toBe("sets");
    expect(at("/projects/VKZ/training/new").key).toBe("sets");
    expect(at("/projects/VKZ/trainsets/s1").key).toBe("sets");
    expect(at("/projects/VKZ/runs")).toEqual({ key: "runs", label: "Обучения" });
    expect(at("/projects/VKZ/runs/14").key).toBe("runs");
    expect(at("/projects/VKZ/training", "?tab=runs").key).toBe("runs");
    expect(at("/projects/VKZ/training/runs/r1").key).toBe("runs");
  });

  it("разделы вне проекта", () => {
    expect(at("/agents/g1", "", undefined).label).toBe("Мои агенты");
    expect(at("/augment", "", undefined).label).toBe("Мои графы");
    expect(at("/hardware", "", undefined).key).toBe("hardware");
    expect(at("/", "", undefined).label).toBe("Все проекты");
  });

  it("код проекта в адресе строчными тоже узнаётся", () => {
    expect(at("/projects/vkz/classes").key).toBe("classes");
  });
});
