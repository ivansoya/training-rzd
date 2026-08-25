"""Полуавтомат по кадру видео: обводит ли он то, по чему щёлкнули.

Проверка сквозная и намеренно грубая: на тестовом ролике нарисован один
оранжевый прямоугольник на тёмном фоне, его место на каждом кадре известно
арифметикой. Щёлкаем в его середину — координатами источника, как это делает
канва редактора, — и смотрим, накрыл ли ответ модели тот самый прямоугольник.

Именно здесь ловится расхождение пространств. Пока кадр для SAM2 брали из
готового перегона, модель получала картинку ступени качества (960×720 у этого
ролика) и точку из 1024×768: щелчок уезжал вниз-вправо на четверть кадра, а
ответ возвращался в пикселях, которых редактор не знает. Снаружи это выглядело
как «модель вернула бесформенное тело».
"""
import pytest
import sample
from conftest import BASE_URL, clip_url, wait_clip

# Прямоугольник рисуется в 320×240 и растягивается до 1024×768 — те же 3.2 по
# обеим осям, что и в `sample.ensure_tall`.
SCALE = sample.TALL_WIDTH / sample.WIDTH
FRAME_NO = 40


def rect_of(frame_no):
    """Где на этом кадре прямоугольник — в пикселях источника."""
    x = 10 + (frame_no * 8) % (sample.WIDTH - 70)
    return {
        "x": x * SCALE,
        "y": 150 * SCALE,
        "w": 60 * SCALE,
        "h": 60 * SCALE,
    }


def iou(a, b):
    x0 = max(a["x"], b["x"])
    y0 = max(a["y"], b["y"])
    x1 = min(a["x"] + a["w"], b["x"] + b["w"])
    y1 = min(a["y"] + a["h"], b["y"] + b["h"])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    cross = (x1 - x0) * (y1 - y0)
    return cross / (a["w"] * a["h"] + b["w"] * b["h"] - cross)


@pytest.fixture(scope="session")
def tall_video_file():
    return sample.ensure_tall()


@pytest.fixture
def tall(api, task, tall_video_file):
    with open(tall_video_file, "rb") as fh:
        res = api.post(
            f"{BASE_URL}/api/tasks/{task['id']}/videos",
            files={"file": ("sample-tall.mp4", fh, "video/mp4")},
            data={"mode": "annotate"},
        )
    assert res.status_code in (200, 201), res.text
    body = res.json()
    body["task_id"] = task["id"]
    wait_clip(api, task["id"], body["id"])
    return body


@pytest.fixture
def session_id(api):
    """Сессия SAM2. Без модели проверять нечего — и это не повод падать:
    полуавтомат требует GPU, которого на сборочной машине может не быть."""
    res = api.post(f"{BASE_URL}/api/auto/sessions", json={"model": "sam2"})
    if res.status_code == 503:
        pytest.skip(f"полуавтомат недоступен: {res.text}")
    assert res.status_code in (200, 201), res.text
    sid = res.json()["session_id"]
    yield sid
    api.delete(f"{BASE_URL}/api/auto/sessions/{sid}")


def test_полуавтомат_обводит_то_по_чему_щёлкнули(api, tall, session_id):
    space = {"w": sample.TALL_WIDTH, "h": sample.TALL_HEIGHT}
    want = rect_of(FRAME_NO)
    point = {"x": want["x"] + want["w"] / 2, "y": want["y"] + want["h"] / 2, "label": 1}

    # Ровно как редактор: сперва достать кадр, потом греть, потом спрашивать.
    res = api.get(clip_url(tall["task_id"], tall["id"]) + "/frame",
                  params={"n": FRAME_NO})
    assert res.status_code == 200, res.text
    assert res.headers.get("X-Frame-Width") == str(sample.TALL_WIDTH)

    ref = {"video_id": tall["id"], "frame_no": FRAME_NO}
    res = api.post(f"{BASE_URL}/api/auto/sessions/{session_id}/warm", json=ref)
    assert res.status_code == 200, res.text
    assert res.json()["width"] == sample.TALL_WIDTH, (
        "кодировщик получил кадр не в разрешении источника"
    )

    res = api.post(f"{BASE_URL}/api/auto/sessions/{session_id}/predict", json={
        **ref,
        "prompts": {"points": [point]},
        "want": ["box", "polygon"],
        "refine": {},
        "space": space,
    })
    assert res.status_code == 200, res.text
    shapes = res.json()["shapes"]
    assert shapes, f"модель не нашла ничего в точке {point}"

    got = shapes[0]["box"]
    assert iou(got, want) > 0.6, (
        f"обводка не легла на прямоугольник: ждали {want}, получили {got}"
    )


def test_ответ_приходит_в_пикселях_разметчика(api, tall, session_id):
    """Рамка обязана помещаться в кадр редактора. Ответ в чужих пикселях
    поместился бы тоже — но занял бы две трети экрана вместо своего места,
    поэтому проверяется не только «влезает», но и «не мельче чем вдвое»."""
    space = {"w": sample.TALL_WIDTH, "h": sample.TALL_HEIGHT}
    want = rect_of(FRAME_NO)
    api.get(clip_url(tall["task_id"], tall["id"]) + "/frame", params={"n": FRAME_NO})
    res = api.post(f"{BASE_URL}/api/auto/sessions/{session_id}/predict", json={
        "video_id": tall["id"], "frame_no": FRAME_NO,
        "prompts": {"box": {
            "x": want["x"] - 20, "y": want["y"] - 20,
            "w": want["w"] + 40, "h": want["h"] + 40,
        }},
        "want": ["box"],
        "refine": {},
        "space": space,
    })
    assert res.status_code == 200, res.text
    shapes = res.json()["shapes"]
    assert shapes, "по рамке-подсказке модель не нашла ничего"
    got = shapes[0]["box"]
    assert 0 <= got["x"] and got["x"] + got["w"] <= space["w"]
    assert 0 <= got["y"] and got["y"] + got["h"] <= space["h"]
    assert got["w"] > want["w"] / 2, "рамка вернулась в пикселях ступени качества"
