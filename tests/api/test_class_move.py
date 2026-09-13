"""Судьба класса: перенос разметки и честная цена удаления.

До этой работы удаление класса считало одни `annotations`, а каскадом уносило
ещё `video_tracks` и `video_annotations`. Класс, размеченный только в несданных
роликах, показывал «0 разметок» — и удаление молча стирало чужие треки вместе
с ключевыми кадрами, которые ставили руками.

Проверяется не «ручка отвечает 200», а совпадение чисел: то, что назвал
`usage`, обязано быть ровно тем, что уезжает или исчезает.
"""
import io

import pytest
import requests
from PIL import Image as PilImage

from conftest import BASE_URL, tag


# --------------------------------------------------------------------------- #
# Общее
# --------------------------------------------------------------------------- #
def make_class(api, project, name):
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/classes",
                   json={"name": name})
    assert res.status_code in (200, 201), res.text
    return res.json()


@pytest.fixture
def image(api, task):
    buf = io.BytesIO()
    PilImage.new("RGB", (400, 200), (40, 60, 90)).save(buf, "JPEG")
    buf.seek(0)
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/images",
                   files={"files": ("test-frame.jpg", buf, "image/jpeg")})
    assert res.status_code in (200, 201), res.text
    listing = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images")
    return listing.json()["images"][0]


def box(cls, x=10, y=10, w=40, h=40):
    return {"class_index": cls["class_index"], "x": x, "y": y, "w": w, "h": h}


def save(api, image_id, boxes, expect=200):
    res = api.put(f"{BASE_URL}/api/images/{image_id}/annotations",
                  json={"boxes": boxes})
    assert res.status_code == expect, res.text
    return res


def usage(api, project, cls, target=None):
    res = api.get(
        f"{BASE_URL}/api/projects/{project['code']}/classes/{cls['id']}/usage",
        params={"target": target["id"]} if target else None,
    )
    assert res.status_code == 200, res.text
    return res.json()


def move(api, project, cls, target, delete_source, expect=200):
    res = api.post(
        f"{BASE_URL}/api/projects/{project['code']}/classes/{cls['id']}/move",
        json={"target_id": target["id"], "delete_source": delete_source},
    )
    assert res.status_code == expect, res.text
    return res.json()


def classes_of(api, project):
    res = api.get(f"{BASE_URL}/api/projects/{project['code']}/classes")
    assert res.status_code == 200, res.text
    return {c["name"]: c for c in res.json()["classes"]}


def member(db, api_session, project, role):
    """Второй человек в проекте с нужной ролью.

    Приглашение с почтой ради одной проверки прав — лишняя зависимость;
    членство кладём прямо в базу тем же, чем его кладёт сервис.
    """
    login = tag()
    session = requests.Session()
    res = session.post(f"{BASE_URL}/api/auth/register", json={
        "email": f"{login}@example.test", "login": login,
        "display_name": "Второй", "password": "Test-Passw0rd",
    })
    assert res.status_code in (200, 201), res.text
    with db.cursor() as cur:
        cur.execute("UPDATE users SET email_confirmed_at = now()"
                    " WHERE login = %s", (login,))
        cur.execute(
            "INSERT INTO project_members (id, project_id, user_id, role,"
            " created_at) SELECT gen_random_uuid(), p.id, u.id,"
            " %s::project_role, now() FROM projects p, users u"
            " WHERE p.code = %s AND u.login = %s",
            (role, project["code"], login),
        )
    res = session.post(f"{BASE_URL}/api/auth/login",
                       json={"identity": login, "password": "Test-Passw0rd"})
    assert res.status_code == 200, res.text
    return session


# --------------------------------------------------------------------------- #
# Перенос разметки кадров
# --------------------------------------------------------------------------- #
def test_перенос_отдаёт_разметку_целевому_классу(api, project, task, image):
    src = make_class(api, project, "шпала")
    dst = make_class(api, project, "рельс")
    save(api, image["id"], [box(src, 10, 10), box(src, 100, 10)])

    out = move(api, project, src, dst, delete_source=True)
    assert out["moved"]["annotations"] == 2
    assert out["source_deleted"] is True

    left = classes_of(api, project)
    assert "шпала" not in left, "исходный класс должен был исчезнуть"
    assert left["рельс"]["annotations"] == 2


def test_перенос_без_удаления_оставляет_класс_пустым(api, project, task, image):
    src = make_class(api, project, "шпала")
    dst = make_class(api, project, "рельс")
    save(api, image["id"], [box(src)])

    out = move(api, project, src, dst, delete_source=False)
    assert out["source_deleted"] is False

    left = classes_of(api, project)
    assert left["шпала"]["annotations"] == 0
    assert left["рельс"]["annotations"] == 1


def test_разметка_целевого_класса_не_трогается(api, project, task, image):
    src = make_class(api, project, "шпала")
    dst = make_class(api, project, "рельс")
    third = make_class(api, project, "опора")
    save(api, image["id"], [box(src, 10, 10), box(dst, 100, 10),
                            box(third, 200, 10)])

    move(api, project, src, dst, delete_source=True)
    left = classes_of(api, project)
    assert left["рельс"]["annotations"] == 2
    assert left["опора"]["annotations"] == 1, "чужой класс переносом не задет"


def test_кадры_с_обоими_классами_сосчитаны_заранее(api, project, task, image):
    src = make_class(api, project, "шпала")
    dst = make_class(api, project, "рельс")
    save(api, image["id"], [box(src, 10, 10), box(dst, 100, 10)])

    said = usage(api, project, src, target=dst)
    assert said["overlap_images"] == 1, "дубли обещаны до операции, а не после"
    out = move(api, project, src, dst, delete_source=True)
    assert out["overlap_images"] == 1


# --------------------------------------------------------------------------- #
# Отказы
# --------------------------------------------------------------------------- #
def test_перенос_в_себя_отвергается(api, project):
    src = make_class(api, project, "шпала")
    move(api, project, src, src, delete_source=False, expect=400)


def test_класс_чужого_проекта_целью_не_годится(api, project):
    src = make_class(api, project, "шпала")
    other = api.post(f"{BASE_URL}/api/projects",
                     json={"name": tag(), "description": "чужой"}).json()
    alien = make_class(api, other, "рельс")
    move(api, project, src, alien, delete_source=False, expect=404)


def test_редактору_судьба_класса_не_доверена(api, db, project, task, image):
    src = make_class(api, project, "шпала")
    dst = make_class(api, project, "рельс")
    save(api, image["id"], [box(src)])
    editor = member(db, api, project, "editor")

    res = editor.post(
        f"{BASE_URL}/api/projects/{project['code']}/classes/{src['id']}/move",
        json={"target_id": dst["id"], "delete_source": True},
    )
    assert res.status_code == 403, res.text
    res = editor.delete(
        f"{BASE_URL}/api/projects/{project['code']}/classes/{src['id']}"
        "?confirm=1"
    )
    assert res.status_code == 403, res.text
    assert classes_of(api, project)["шпала"]["annotations"] == 1


# --------------------------------------------------------------------------- #
# Цена удаления
# --------------------------------------------------------------------------- #
def test_удаление_без_подтверждения_называет_цену(api, project, task, image):
    src = make_class(api, project, "шпала")
    save(api, image["id"], [box(src, 10, 10), box(src, 100, 10)])

    res = api.delete(
        f"{BASE_URL}/api/projects/{project['code']}/classes/{src['id']}"
    )
    assert res.status_code == 409, res.text
    body = res.json()
    assert body["code"] == "confirm_required"
    assert body["annotations"] == 2
    assert classes_of(api, project)["шпала"], "класс не должен был исчезнуть"


def test_обещанное_и_удалённое_совпадают(api, project, task, image):
    src = make_class(api, project, "шпала")
    save(api, image["id"], [box(src, 10, 10), box(src, 100, 10)])

    said = usage(api, project, src)
    res = api.delete(
        f"{BASE_URL}/api/projects/{project['code']}/classes/{src['id']}"
        "?confirm=1"
    )
    assert res.status_code == 200, res.text
    done = res.json()
    assert done["deleted_annotations"] == said["annotations"]
    assert done["deleted_tracks"] == said["video_tracks"]
    assert done["deleted_keys"] == said["video_keys"]


# --------------------------------------------------------------------------- #
# Номер класса
# --------------------------------------------------------------------------- #
def test_освободившийся_номер_не_переиспользуется(api, project):
    first = make_class(api, project, "шпала")
    second = make_class(api, project, "рельс")
    assert second["class_index"] == first["class_index"] + 1

    res = api.delete(
        f"{BASE_URL}/api/projects/{project['code']}/classes/{second['id']}"
        "?confirm=1"
    )
    assert res.status_code == 200, res.text

    third = make_class(api, project, "опора")
    assert third["class_index"] != second["class_index"], (
        "номер уходит в мету выгрузки: «3 = Шпала» из прошлого экспорта не "
        "должно однажды означать другой класс"
    )
    assert third["class_index"] == second["class_index"] + 1


# --------------------------------------------------------------------------- #
# Открытый редактор
# --------------------------------------------------------------------------- #
def test_сохранение_с_исчезнувшим_классом_отказывает(api, project, task, image):
    """Молчаливый пропуск здесь означал стирание: сохранение сносит всю
    разметку кадра и вставляет заново."""
    keep = make_class(api, project, "рельс")
    gone = make_class(api, project, "шпала")
    save(api, image["id"], [box(keep, 10, 10), box(gone, 100, 10)])

    res = api.delete(
        f"{BASE_URL}/api/projects/{project['code']}/classes/{gone['id']}"
        "?confirm=1"
    )
    assert res.status_code == 200, res.text

    # Редактор всё ещё держит оба бокса и шлёт их обратно.
    res = save(api, image["id"],
               [box(keep, 10, 10), box(gone, 100, 10)], expect=409)
    assert res.json()["code"] == "class_gone"
    # И уцелевший бокс на месте: отказ не должен был ничего переписать.
    listing = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()
    boxes = [row for row in listing["images"] if row["id"] == image["id"]][0]
    assert len(boxes["boxes"]) == 1


# --------------------------------------------------------------------------- #
# Разметка роликов
# --------------------------------------------------------------------------- #
def make_track(api, task, video, cls, frame_no=0):
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/tracks",
        json={"class_index": cls["class_index"], "frame_no": frame_no,
              "geometry": {"x": 10, "y": 90, "w": 60, "h": 60}},
    )
    assert res.status_code == 201, res.text
    return res.json()


def track_rows(db, track_id):
    """Класс трека и классы его ключей — прямо из базы.

    Через базу, а не через выдачу: у ключа собственный `class_id`, и выдача
    его не показывает — при закрытии ролика класс берётся у трека. Ровно
    поэтому разошедшийся ключ и оставался незамеченным.
    """
    with db.cursor() as cur:
        cur.execute("SELECT class_id FROM video_tracks WHERE id = %s",
                    (track_id,))
        track = cur.fetchone()[0]
        cur.execute("SELECT class_id FROM video_annotations WHERE track_id = %s",
                    (track_id,))
        keys = [row[0] for row in cur.fetchall()]
    return str(track), [str(k) for k in keys]


def test_класс_видит_треки_несданных_роликов(api, project, task, video):
    """Раньше здесь стоял ноль, и удаление уносило треки молча."""
    src = make_class(api, project, "шпала")
    make_track(api, task, video, src)

    said = usage(api, project, src)
    assert said["annotations"] == 0
    assert said["video_tracks"] == 1
    assert said["video_keys"] == 1
    assert [t["id"] for t in said["tasks"]] == [task["id"]]


def test_удаление_называет_треки_при_нулевой_разметке(api, project, task, video):
    src = make_class(api, project, "шпала")
    make_track(api, task, video, src)

    res = api.delete(
        f"{BASE_URL}/api/projects/{project['code']}/classes/{src['id']}"
    )
    assert res.status_code == 409, res.text
    assert res.json()["video_tracks"] == 1


def test_перенос_тащит_трек_вместе_с_ключами(api, db, project, task, video):
    src = make_class(api, project, "шпала")
    dst = make_class(api, project, "рельс")
    track = make_track(api, task, video, src)
    res = api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
                  json={"geometry": {"x": 170, "y": 90, "w": 60, "h": 60}})
    assert res.status_code == 200, res.text

    out = move(api, project, src, dst, delete_source=True)
    assert out["moved"]["video_tracks"] == 1
    assert out["moved"]["video_keys"] == 2

    cls, keys = track_rows(db, track["id"])
    assert cls == dst["id"]
    assert keys and set(keys) == {dst["id"]}, (
        "ключ, оставшийся на исчезнувшем классе, был бы снесён каскадом — "
        "то есть перенос потерял бы ровно то, ради чего затевался"
    )


def test_перенос_пишет_в_ленту_таски(api, project, task, video):
    src = make_class(api, project, "шпала")
    dst = make_class(api, project, "рельс")
    make_track(api, task, video, src)
    move(api, project, src, dst, delete_source=True)

    res = api.get(f"{BASE_URL}/api/tasks/{task['id']}/events")
    assert res.status_code == 200, res.text
    moved = [e for e in res.json()["events"] if e["kind"] == "class_moved"]
    assert moved, "разметчик обязан увидеть, почему его треки называются иначе"
    assert moved[0]["payload"]["from"] == "шпала"
    assert moved[0]["payload"]["to"] == "рельс"
