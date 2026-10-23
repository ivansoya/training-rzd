import { describe, expect, it } from "vitest";
import { boxAt, cornerAt, moveBox, resizeBox, sameBoxes, spanBox, usable } from "./pictureBox";
import type { Box } from "./pictureBox";
import { onShelf, pictureKey, pictureTiles, pickedOf, pickedOfItem, refOf, shelvesOf } from "./examplePick";
import type { Picture } from "../../api/agents";

describe("рамка своей картинки", () => {
  it("по двум точкам в любом порядке и обрезана краем", () => {
    expect(spanBox([50, 40], [10, 10], 100, 80)).toEqual([10, 10, 40, 30]);
    expect(spanBox([-20, -5], [130, 90], 100, 80)).toEqual([0, 0, 100, 80]);
  });

  it("мельче 8 px не годится", () => {
    expect(usable([0, 0, 7.9, 100])).toBe(false);
    expect(usable([0, 0, 8, 8])).toBe(true);
  });

  it("сдвиг не выпускает за край", () => {
    expect(moveBox([10, 10, 30, 20], 100, -50, 100, 80)).toEqual([70, 0, 30, 20]);
  });

  it("угол тянется, противоположный стоит; перетянутый за него — меняет сторону", () => {
    expect(resizeBox([10, 10, 30, 20], "se", [60, 50], 100, 80)).toEqual([10, 10, 50, 40]);
    expect(resizeBox([10, 10, 30, 20], "nw", [60, 50], 100, 80)).toEqual([40, 30, 20, 20]);
  });

  it("попадание в угол с допуском и в мельчайшую из вложенных", () => {
    const big: Box = [0, 0, 100, 80], small: Box = [20, 20, 10, 10];
    expect(cornerAt(small, [31, 29], 2)).toBe("se");
    expect(cornerAt(small, [25, 25], 2)).toBeNull();
    expect(boxAt([big, small], [25, 25])).toBe(1);
    expect(boxAt([big, small], [5, 5])).toBe(0);
    expect(boxAt([small], [90, 70])).toBe(-1);
  });

  it("те же рамки — с точностью до округления сервера", () => {
    expect(sameBoxes([[1, 2, 3, 4]], [[1.01, 2, 3, 4]])).toBe(true);
    expect(sameBoxes([[1, 2, 3, 4]], [[1.2, 2, 3, 4]])).toBe(false);
    expect(sameBoxes([], [[1, 2, 3, 4]])).toBe(false);
  });
});

const pic = (id: string, shelf: string, boxes: Box[]): Picture => ({
  id, shelf, file_name: `${id}.jpg`, width: 1600, height: 1200, boxes, locked: null, created_at: "",
});

describe("полка своих картинок", () => {
  it("плитка и образец набора с картинки — один ключ: щелчок находит рамку в наборе", () => {
    const [tile] = pictureTiles([pic("a", "Борщевик", [[10.04, 20, 30, 40]])]);
    const fromSet = pickedOfItem({ uid: "sha1", file_name: "a.jpg", side: 30, image_id: null, picture_id: "a", box: [10, 20, 30, 40] });
    expect(tile.uid).toBe(pictureKey("a", [10, 20, 30, 40]));
    expect(pickedOf(tile).uid).toBe(fromSet.uid);
    expect(refOf(fromSet)).toEqual({ picture_id: "a", box: [10, 20, 30, 40] });
  });

  it("каждая рамка — свой предмет, группы не пересекаются с кадрами проекта", () => {
    const tiles = pictureTiles([pic("a", "x", [[0, 0, 10, 10], [20, 20, 10, 10]]), pic("b", "x", [[0, 0, 10, 10]])]);
    expect(tiles.map((t) => t.group)).toEqual([-1, -2, -3]);
  });

  it("полки: открытая первой даже пустая, имя без регистра и ё", () => {
    const all = [pic("a", "борщевик", []), pic("b", "Ёлка", []), pic("c", "Арка", []), pic("d", "Борщевик", [])];
    expect(shelvesOf(all, "Борщевик")).toEqual([
      { name: "Борщевик", count: 2 }, { name: "Арка", count: 1 }, { name: "Ёлка", count: 1 },
    ]);
    expect(shelvesOf([], "Борщевик")).toEqual([{ name: "Борщевик", count: 0 }]);
    expect(onShelf(all, "елка").map((p) => p.id)).toEqual(["b"]);
  });
});
