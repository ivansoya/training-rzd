"""SAM2 внутри воркера.

Дорогая часть — кодировщик кадра: он считается один раз на изображение, а
дальше клики декодируются за миллисекунды. Поэтому эмбеддинги кэшируются по
image_id, а редактор заранее греет текущий кадр и следующий по ленте.

Наружу раннер отдаёт бокс независимо от того, что модель работает масками:
хранилище разметки сейчас знает только боксы. Маска и полигон в ответе
предусмотрены и считаются по запросу — цепочка «детектор дал грубо, SAM2
уточнил» и сегментация появятся поверх готового протокола.
"""
import os
import urllib.request

import numpy as np

from common import config

WEIGHTS_URL = "https://dl.fbaipublicfiles.com/segment_anything_2/092824/"
# Имя веса -> (файл, конфиг внутри пакета sam2).
CHECKPOINTS = {
    "sam2.1_hiera_tiny": ("sam2.1_hiera_tiny.pt", "configs/sam2.1/sam2.1_hiera_t.yaml"),
    "sam2.1_hiera_small": ("sam2.1_hiera_small.pt", "configs/sam2.1/sam2.1_hiera_s.yaml"),
    "sam2.1_hiera_base_plus": (
        "sam2.1_hiera_base_plus.pt",
        "configs/sam2.1/sam2.1_hiera_b+.yaml",
    ),
    "sam2.1_hiera_large": ("sam2.1_hiera_large.pt", "configs/sam2.1/sam2.1_hiera_l.yaml"),
}
DEFAULT_MODEL = os.environ.get("SAM2_MODEL", "sam2.1_hiera_small")
# Сколько кадров держать закодированными: текущий, соседний и немного истории.
CACHE_SIZE = int(os.environ.get("SAM2_CACHE", "4"))
# Три маски SAM2 — это разбор неоднозначности «что именно вы ткнули».
# Сортируем их по площади, чтобы уровень был предсказуемым, а не как повезёт.
DETAIL_ORDER = {"subpart": 0, "part": 1, "object": 2}
# По умолчанию берём ту, в которой уверена сама модель: самая крупная из трёх
# сплошь и рядом оказывается мусором с уверенностью 0,07, тогда как средняя
# даёт 0,6. Явные уровни остаются для случая, когда человек знает лучше.
DETAIL_AUTO = "auto"
# Сколько кусков маски отдавать контуром и с какой доли от крупнейшего они
# перестают быть шумом обводки.
MAX_PARTS = 24
PART_MIN_SHARE = 0.002


def ensure_weights(name: str) -> str:
    """Скачиваем на том при первом запуске: образ от весов не пухнет."""
    if name not in CHECKPOINTS:
        raise ValueError(f"Неизвестный вес SAM2: {name}")
    file_name, _ = CHECKPOINTS[name]
    target_dir = config.auto_weights_dir("sam2")
    os.makedirs(target_dir, exist_ok=True)
    path = os.path.join(target_dir, file_name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    tmp = path + ".part"
    urllib.request.urlretrieve(WEIGHTS_URL + file_name, tmp)
    os.replace(tmp, path)
    return path


class Sam2Runner:
    def __init__(self, params: dict):
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        self.name = params.get("model") or DEFAULT_MODEL
        self.device = params.get("device") or os.environ.get("SAM2_DEVICE", "cuda")
        if self.device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError(
                "GPU недоступен: сервис полуавтоматической разметки требует CUDA."
            )
        _, cfg = CHECKPOINTS[self.name]
        checkpoint = ensure_weights(self.name)
        self._torch = torch
        model = build_sam2(cfg, checkpoint, device=self.device)
        self.predictor = SAM2ImagePredictor(model)
        # image_id -> состояние кодировщика. Лезем во внутренние поля предиктора
        # осознанно: публичного способа переключаться между закодированными
        # кадрами у него нет, а перекодировать каждый клик — это секунды.
        self._cache: dict[str, dict] = {}
        self._order: list[str] = []
        self._current: str | None = None

    # -- кадры ------------------------------------------------------------ #
    def _encode(self, image_path: str, image_id: str):
        from PIL import Image as PilImage

        with PilImage.open(image_path) as img:
            array = np.array(img.convert("RGB"))
        self.predictor.set_image(array)
        state = {
            "features": self.predictor._features,
            "orig_hw": self.predictor._orig_hw,
            "size": array.shape[:2],
        }
        self._cache[image_id] = state
        self._order.append(image_id)
        while len(self._order) > CACHE_SIZE:
            self._cache.pop(self._order.pop(0), None)
        self._current = image_id
        return state

    def _select(self, image_path: str, image_id: str):
        state = self._cache.get(image_id)
        if state is None:
            return self._encode(image_path, image_id)
        if self._current != image_id:
            self.predictor._features = state["features"]
            self.predictor._orig_hw = state["orig_hw"]
            self.predictor._is_image_set = True
            self._current = image_id
        return state

    def warm(self, image_path: str, image_id: str) -> dict:
        state = self._select(image_path, image_id)
        h, w = state["size"]
        return {"image_id": image_id, "width": int(w), "height": int(h), "cached": True}

    def info(self) -> dict:
        return {
            "model": self.name,
            "device": self.device,
            "cached_images": len(self._order),
        }

    # -- предсказание ------------------------------------------------------ #
    def predict(self, image_path, image_id, prompts, want, refine) -> dict:
        state = self._select(image_path, image_id)
        h, w = state["size"]

        points = prompts.get("points") or []
        coords = np.array([[p["x"], p["y"]] for p in points], dtype=np.float32) if points else None
        labels = np.array([int(p.get("label", 1)) for p in points], dtype=np.int32) if points else None
        box = prompts.get("box")
        box_arr = None
        if box:
            box_arr = np.array(
                [box["x"], box["y"], box["x"] + box["w"], box["y"] + box["h"]],
                dtype=np.float32,
            )
        if coords is None and box_arr is None:
            return {"shapes": []}

        masks, scores, _ = self.predictor.predict(
            point_coords=coords,
            point_labels=labels,
            box=box_arr,
            multimask_output=True,
        )
        detail = refine.get("detail") or DETAIL_AUTO
        if detail == DETAIL_AUTO or detail not in DETAIL_ORDER:
            pick = int(np.argmax(scores))
        else:
            order = np.argsort([float(m.sum()) for m in masks])
            pick = int(order[min(DETAIL_ORDER[detail], len(order) - 1)])
        mask = masks[pick].astype(np.uint8)
        score = float(scores[pick])

        if score < float(refine.get("score_min", 0.0)):
            return {"shapes": [], "score": score, "reason": "low_score"}

        mask = self._clean(mask, refine)
        rect = self._bounds(mask)
        if rect is None:
            return {"shapes": [], "score": score, "reason": "empty_mask"}

        shape = {"type": "box", "box": rect, "score": score}
        if "polygon" in (want or []):
            shape["polygons"] = self._polygons(mask, int(refine.get("polygon_points", 0)))
        return {"shapes": [shape], "width": int(w), "height": int(h)}

    # -- чистка маски ------------------------------------------------------ #
    def _clean(self, mask: np.ndarray, refine: dict) -> np.ndarray:
        import cv2

        min_area = int(refine.get("min_area", 0))
        if min_area > 0:
            count, labels_img, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
            keep = np.zeros_like(mask)
            for i in range(1, count):
                if stats[i, cv2.CC_STAT_AREA] >= min_area:
                    keep[labels_img == i] = 1
            mask = keep
        if refine.get("fill_holes"):
            # Замыкание закрывает дыры внутри объекта, не трогая его границу.
            kernel = np.ones((5, 5), np.uint8)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        return mask

    @staticmethod
    def _bounds(mask: np.ndarray):
        """Бокс — крайние точки маски. Пиксели, как везде в проекте."""
        ys, xs = np.nonzero(mask)
        if not len(xs):
            return None
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        return {"x": x0, "y": y0, "w": x1 - x0 + 1, "h": y1 - y0 + 1}

    @staticmethod
    def _polygons(mask: np.ndarray, max_points: int):
        """Все куски маски, а не только крупнейший.

        Объект часто распадается на несколько областей — заслонён стойкой,
        виден двумя половинами. Бокс охватывает их все, и контур обязан
        показывать то же самое, иначе рамка и обводка противоречат друг другу.
        """
        import cv2

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return []
        contours = sorted(contours, key=cv2.contourArea, reverse=True)[:MAX_PARTS]
        biggest = cv2.contourArea(contours[0]) or 1.0
        out = []
        for contour in contours:
            # Крохи в доли процента от главного куска — это шум обводки.
            if cv2.contourArea(contour) < biggest * PART_MIN_SHARE:
                continue
            if max_points and len(contour) > max_points:
                # Подбираем допуск, пока точек не станет достаточно мало.
                perimeter = cv2.arcLength(contour, True)
                eps = 0.001
                while eps < 0.2:
                    approx = cv2.approxPolyDP(contour, eps * perimeter, True)
                    if len(approx) <= max_points:
                        contour = approx
                        break
                    eps *= 1.6
            out.append([[int(p[0][0]), int(p[0][1])] for p in contour])
        return out
