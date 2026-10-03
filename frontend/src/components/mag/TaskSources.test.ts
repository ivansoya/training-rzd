import { describe, expect, it } from "vitest";
import { buildSources } from "./TaskSources";
import type { TaskDetail } from "../../auth/api";

const video = (id: string, mode: string) =>
  ({ id, mode, file_name: `${id}.mp4`, created_at: "2026-10-01T10:00:00Z", segments: [] }) as never;

describe("источники вкладки «Кадры»", () => {
  it("закрытая разметка ролика даёт свой блок с кадрами агента", () => {
    const task = {
      videos: [video("v1", "annotate"), video("v2", "annotate")],
      by_source: { v1: { new: 16, agent: 16 } },
    } as unknown as TaskDetail;
    const blocks = buildSources(task);
    expect(blocks.map((b) => b.key)).toEqual(["v1"]);
    expect(blocks[0]).toMatchObject({ kind: "annotate", total: 16, title: "Кадры из разметки «v1.mp4»" });
    expect(blocks[0].counts.agent).toBe(16);
  });
});
