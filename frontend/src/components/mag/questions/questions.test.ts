import { describe, expect, it } from "vitest";
import type { Question } from "../../../api/questions";
import { askedObjects, atPlace, heldPlaces, nextAsked, openByVideo, placeKey, questionsWord } from "./questions";

const q = (over: Partial<Question>): Question => ({
  id: "q", status: "open", place: "x", image_id: null, video_id: null, frame_no: null, time_ms: null,
  object_id: null, object_kind: null, object_gone: false, class: null, author: "А", author_id: "a",
  created_at: "2026-10-29T10:00:00Z", last_at: "2026-10-29T10:00:00Z", resolved_by: null, resolved_at: null,
  can_settle: true, messages: [], ...over,
});

describe("вопросы в разметке (решения 29.10.2026)", () => {
  const list = [
    q({ id: "1", video_id: "v", frame_no: 575, object_id: "t3" }),
    q({ id: "2", video_id: "v", frame_no: 575 }),
    q({ id: "3", video_id: "v", frame_no: 1025 }),
    q({ id: "4", image_id: "i12", object_id: "b1" }),
    q({ id: "5", image_id: "i9", status: "resolved" }),
    q({ id: "6", image_id: "i12", object_id: "gone", object_gone: true }),
  ];

  it("кадр с двумя вопросами держится один раз, решённые не держат", () => {
    expect(heldPlaces(list)).toBe(3);
    expect(openByVideo(list)).toEqual(new Map([["v", 3]]));
  });

  it("пузырёк — у живых объектов с открытым вопросом", () => {
    expect(askedObjects(list)).toEqual(new Set(["t3", "b1"]));
  });

  it("вопросы места: открытые сверху", () => {
    const at = atPlace([q({ id: "r", image_id: "i", status: "resolved", created_at: "2026-10-28T00:00:00Z" }),
      q({ id: "o", image_id: "i" })], { image_id: "i" });
    expect(at.map((x) => x.id)).toEqual(["o", "r"]);
    expect(atPlace(list, { video_id: "v", frame_no: 575 }).map((x) => x.id)).toEqual(["1", "2"]);
  });

  it("Alt+[ и Alt+] — соседнее место с открытым вопросом по ленте", () => {
    const order = ["i:i1", "i:i9", "i:i12", "i:i20"];
    expect(nextAsked(list, order, "i:i1", 1)).toBe("i:i12");
    expect(nextAsked(list, order, "i:i12", 1)).toBeNull();
    expect(nextAsked(list, order, "i:i20", -1)).toBe("i:i12");
    expect(placeKey(list[0])).toBe("v:v:575");
  });

  it("слово", () => {
    expect([1, 2, 5, 21].map(questionsWord)).toEqual(["1 вопрос", "2 вопроса", "5 вопросов", "21 вопрос"]);
  });
});
