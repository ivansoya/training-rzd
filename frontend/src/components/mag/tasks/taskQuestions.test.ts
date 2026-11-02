import { describe, expect, it } from "vitest";
import type { TaskVideoItem } from "../../../auth/api";
import type { Question } from "../../../api/questions";
import { placeParts, questionGo, repliesText } from "./taskQuestions";

const q = (over: Partial<Question>): Question => ({
  id: "q", status: "open", place: "x", image_id: null, video_id: null, frame_no: null, time_ms: null,
  object_id: null, object_kind: null, object_gone: false, class: null, author: "А", author_id: "a",
  created_at: "2026-10-29T10:00:00Z", last_at: "2026-10-29T10:00:00Z", resolved_by: null, resolved_at: null,
  can_settle: true, messages: [], ...over,
});
const msg = { id: "m", text: "т", author: "А", author_id: "a", at: "", edited: false, can_edit: false };
const vid = (over: Partial<TaskVideoItem>) => ({ id: "v", mode: "annotate", prepare: { ready: true }, ...over }) as TaskVideoItem;

describe("вопросы на странице таски", () => {
  it("место ролика — имя и время порознь, изображения — как есть", () => {
    expect(placeParts({ place: "cam_5.mp4, 0:23", time_ms: 23_400 })).toEqual(["cam_5.mp4", "0:23"]);
    expect(placeParts({ place: "IMG_1.jpg", time_ms: null })).toEqual(["IMG_1.jpg", null]);
  });

  it("ответы без самого вопроса", () => {
    expect(repliesText({ messages: [msg] })).toBe("нет ответов");
    expect(repliesText({ messages: [msg, msg, msg] })).toBe("2 ответа");
  });

  it("кадр — в редактор кадров, ролик — только готовый на разметку", () => {
    expect(questionGo(q({ image_id: "i" }), [])).toEqual({ image: "i" });
    const v = vid({});
    expect(questionGo(q({ video_id: "v", frame_no: 5 }), [v])).toEqual({ video: v });
    expect(questionGo(q({ video_id: "v" }), [vid({ prepare: { ready: false } as TaskVideoItem["prepare"] })])).toBeNull();
    expect(questionGo(q({ video_id: "v" }), [vid({ mode: "cut" })])).toBeNull();
    expect(questionGo(q({ video_id: "gone" }), [v])).toBeNull();
    expect(questionGo(undefined, [v])).toBeNull();
  });
});
