import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTaskEditorWindow } from "../../../auth/api";
import type { TaskImage } from "../../../auth/api";
import { frameWindows } from "./editorImages";

vi.mock("../../../auth/api", () => ({ getTaskEditorWindow: vi.fn() }));
const request = vi.mocked(getTaskEditorWindow);
const image = (id: string): TaskImage => ({ id, file_name: `${id}.jpg`, width: 640, height: 480, size_bytes: 100,
  task_status: "new", accepted: false, source_video_id: null, source_time_ms: null, tag_ids: [], annotations: 0, boxes: [] });
const ids = (start: number) => Array.from({ length: 100 }, (_, i) => String(start + i));

beforeEach(() => { request.mockReset(); });

describe("окна редактора таски", () => {
  it("загружает дальнее окно напрямую и хранит до 300 подробных кадров", async () => {
    request.mockImplementation(async (_task, names) => names.map(image));
    const windows = frameWindows("task", ids(0).map(image), vi.fn());
    await windows.load(ids(35_000));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual(ids(35_000));
    await windows.load(ids(35_000));
    expect(request).toHaveBeenCalledTimes(1);
    await windows.load(ids(12_000));
    await windows.load(ids(36_000));
    expect(windows.get("0")).toBeUndefined();
    expect(windows.get("35000")?.id).toBe("35000");
    expect(windows.get("36099")?.id).toBe("36099");
  });

  it("отбрасывает запоздавший ответ после перемотки и закрытия", async () => {
    const response: Array<() => void> = [];
    const changed = vi.fn();
    request.mockImplementation((_task, names) => new Promise((resolve) => response.push(() => resolve(names.map(image)))));
    const windows = frameWindows("task", [], changed);
    const old = windows.load(ids(0), true);
    const next = windows.load(ids(20_000), true);
    expect(request.mock.calls[0][2].aborted).toBe(true);
    const back = windows.load(ids(0), true);
    expect(request).toHaveBeenCalledTimes(3);
    response[0]();
    await old;
    expect(windows.get("0")).toBeUndefined();
    expect(windows.load(ids(0), true)).toBe(back);
    windows.close();
    expect(request.mock.calls[1][2].aborted).toBe(true);
    expect(request.mock.calls[2][2].aborted).toBe(true);
    response[1]();
    response[2]();
    await Promise.all([next, back]);
    expect(changed).not.toHaveBeenCalled();
  });
});
