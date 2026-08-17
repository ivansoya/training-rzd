"""Интерполяция треков и план выгрузки — без базы и без сервера.

Это тот расчёт, который решает, какие кадры и с какими боксами уедут в проект.
Ошибка здесь тихо испортит датасет, поэтому проверяется отдельно от всего
остального: ни контейнеров, ни ролика, ни сети.
"""
import pytest

from datasets_svc.video_tracks import (
    MAX_TRACK_FRAMES,
    TrackError,
    box_at,
    export_frames,
    frame_to_ms,
    interpolate,
    is_hidden,
    ms_to_frame,
    normalize_ranges,
    plan,
    state_at,
    track_end,
)


def key(frame_no, x, y=0, w=10, h=10):
    return {
        "frame_no": frame_no,
        "geometry": {"x": x, "y": y, "w": w, "h": h},
        "source": "human",
    }


@pytest.fixture
def track():
    return {
        "id": "t1",
        "class_id": "c1",
        "start_frame": 100,
        "end_frame": 160,
        "interpolate": True,
        "export_step": 5,
        "hidden_ranges": [],
    }


@pytest.fixture
def keys():
    return [key(100, 0, 0), key(160, 60, 30)]


# --- интерполяция ---------------------------------------------------------- #
def test_ключевой_кадр_отдаётся_как_есть(track, keys):
    assert box_at(track, keys, 100) == {"x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0}


def test_середина_между_ключами_считается_линейно(track, keys):
    assert box_at(track, keys, 130) == {"x": 30.0, "y": 15.0, "w": 10.0, "h": 10.0}


def test_четверть_пути(track, keys):
    assert box_at(track, keys, 115)["x"] == 15.0


def test_размер_тоже_интерполируется(track):
    keys = [key(100, 0, 0, 10, 10), key(200, 0, 0, 50, 30)]
    track = dict(track, end_frame=200)
    box = box_at(track, keys, 150)
    assert box["w"] == 30.0 and box["h"] == 20.0


def test_до_появления_объекта_нет(track, keys):
    assert box_at(track, keys, 99) is None


def test_после_исчезновения_объекта_нет(track, keys):
    assert box_at(track, keys, 161) is None


def test_без_интерполяции_бокс_держит_предыдущий_ключ(track, keys):
    still = dict(track, interpolate=False)
    assert box_at(still, keys, 130) == {"x": 0, "y": 0, "w": 10, "h": 10}


def test_после_последнего_ключа_бокс_замирает():
    # Конец трека не задан: он живёт до последнего ключа и там же стоит.
    track = {"start_frame": 0, "end_frame": None, "interpolate": True,
             "export_step": 1, "hidden_ranges": []}
    keys = [key(0, 0), key(10, 100)]
    assert box_at(track, keys, 10)["x"] == 100


def test_пустой_трек_ничего_не_отдаёт(track):
    assert box_at(track, [], 100) is None


# --- заслонённость --------------------------------------------------------- #
def test_заслонённый_участок_не_отдаёт_бокс(track, keys):
    hidden = dict(track, hidden_ranges=[[120, 140]])
    assert box_at(hidden, keys, 130) is None


def test_заслонённый_объект_всё_равно_где_то_находится(track, keys):
    """Редактор рисует его прерывистой рамкой, значит место знать надо."""
    hidden = dict(track, hidden_ranges=[[120, 140]])
    state = state_at(hidden, keys, 130)
    assert state["hidden"] is True
    assert state["geometry"] == {"x": 30.0, "y": 15.0, "w": 10.0, "h": 10.0}


def test_за_краем_отрезка_объект_снова_виден(track, keys):
    hidden = dict(track, hidden_ranges=[[120, 140]])
    assert box_at(hidden, keys, 119) is not None
    assert box_at(hidden, keys, 140) is not None


def test_отрезок_полуоткрыт(track):
    assert is_hidden({"hidden_ranges": [[10, 20]]}, 10) is True
    assert is_hidden({"hidden_ranges": [[10, 20]]}, 19) is True
    assert is_hidden({"hidden_ranges": [[10, 20]]}, 20) is False


def test_пересекающиеся_отрезки_склеиваются():
    assert normalize_ranges([[30, 40], [10, 20], [15, 25]]) == [[10, 25], [30, 40]]


def test_пустой_отрезок_отбрасывается():
    assert normalize_ranges([[10, 10], [20, 15]]) == []


def test_кривой_отрезок_отвергается():
    with pytest.raises(TrackError):
        normalize_ranges([["ой", 5]])


# --- план выгрузки --------------------------------------------------------- #
def test_шаг_задаёт_плотность_выгрузки(track, keys):
    frames = export_frames(track, keys)
    assert frames[0] == 100 and frames[-1] == 160
    assert frames == list(range(100, 161, 5))


def test_ключевые_кадры_попадают_всегда(track):
    # Ключ на 137 не кратен шагу 5, но руками поставлен — значит нужен.
    keys = [key(100, 0), key(137, 37), key(160, 60)]
    assert 137 in export_frames(track, keys)


def test_заслонённые_кадры_из_выгрузки_выпадают(track, keys):
    hidden = dict(track, hidden_ranges=[[120, 140]])
    frames = export_frames(hidden, keys)
    assert not [f for f in frames if 120 <= f < 140]
    assert 140 in frames


def test_слишком_мелкий_шаг_отвергается():
    track = {"start_frame": 0, "end_frame": MAX_TRACK_FRAMES * 2,
             "interpolate": True, "export_step": 1, "hidden_ranges": []}
    with pytest.raises(TrackError):
        export_frames(track, [key(0, 0)])


def test_план_собирает_треки_и_одиночные_боксы(track, keys):
    result = plan(
        [dict(track, keys=keys)],
        [{"frame_no": 7, "class_id": "c2", "geometry": {"x": 1, "y": 1, "w": 2, "h": 2},
          "visible": True, "source": "human"}],
    )
    assert 7 in result
    assert result[7][0]["class_id"] == "c2"
    assert result[7][0]["track_id"] is None
    assert 130 in result and result[130][0]["track_id"] == "t1"


def test_план_пуст_когда_размечать_нечего():
    assert plan([], []) == {}


def test_посчитанное_положение_помечается_машинным(track, keys):
    result = plan([dict(track, keys=keys)], [])
    # На ключевом кадре автор — человек, между ключами — расчёт.
    assert result[100][0]["source"] == "human"
    assert result[105][0]["source"] == "model"


# --- время и кадры --------------------------------------------------------- #
@pytest.mark.parametrize("frame_no,fps,expected", [(0, 25, 0), (25, 25, 1000), (30, 30, 1000)])
def test_кадр_переводится_во_время(frame_no, fps, expected):
    assert frame_to_ms(frame_no, fps) == expected


def test_без_частоты_время_не_выдумывается():
    assert frame_to_ms(100, None) == 0
    assert ms_to_frame(1000, 0) == 0


def test_жизнь_трека_без_конца_упирается_в_последний_ключ():
    """До конца ролика он не тянется: иначе замер бы в последнем положении и
    потащил в датасет кадры, которых никто не размечал."""
    track = {"start_frame": 10, "end_frame": None}
    assert track_end(track, [key(10, 0), key(48, 5)]) == 48
    assert track_end(track, []) == 10


def test_интерполяция_округляет_до_сотых():
    a = {"x": 0, "y": 0, "w": 1, "h": 1}
    b = {"x": 1, "y": 1, "w": 1, "h": 1}
    assert interpolate(a, b, 1 / 3)["x"] == 0.33
