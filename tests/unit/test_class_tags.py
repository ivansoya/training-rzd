"""Таги классов на отдельной PostgreSQL: свой справочник, не таги кадров."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

url = os.environ.get("TEST_CLASS_TAGS_DATABASE_URL")
if not url:
    pytest.skip("Нужна отдельная TEST_CLASS_TAGS_DATABASE_URL", allow_module_level=True)
assert os.environ.get("DATABASE_URL") == url

from flask import Flask
from sqlalchemy import select
from common.auth import hash_token
from common.db import Base, SessionLocal, engine
from common.models import AuthSession, ClassTag, LabelClass, LabelClassTag, Project, ProjectMember, Tag, User
from datasets_svc.project_routes import bp


@pytest.fixture(scope="module", autouse=True)
def schema():
    Base.metadata.create_all(engine)


@pytest.fixture
def scene():
    db = SessionLocal(); key = uuid.uuid4().hex
    viewer_key = uuid.uuid4().hex
    user = User(email=f"{key}@test.invalid", login=key, display_name="Тест", password_hash="test")
    viewer = User(email=f"{viewer_key}@test.invalid", login=viewer_key, display_name="Зритель", password_hash="test")
    project = Project(name="test-class-tags", code=key[:20], next_class_index=2)
    foreign = Project(name="test-other", code=uuid.uuid4().hex[:20])
    db.add_all([user, viewer, project, foreign]); db.flush()
    expires = datetime.now(timezone.utc) + timedelta(days=1)
    db.add_all([ProjectMember(project_id=project.id, user_id=user.id, role="admin"),
                ProjectMember(project_id=project.id, user_id=viewer.id, role="viewer"),
                AuthSession(user_id=user.id, token_hash=hash_token(key), expires_at=expires),
                AuthSession(user_id=viewer.id, token_hash=hash_token(viewer_key), expires_at=expires)])
    person = LabelClass(project_id=project.id, name="Человек", class_index=0, color="#46a758")
    car = LabelClass(project_id=project.id, name="Машина", class_index=1, color="#3e63dd")
    frame_tag = Tag(project_id=project.id, name="Ночь")
    alien = ClassTag(project_id=foreign.id, name="Люди")
    db.add_all([person, car, frame_tag, alien]); db.commit()
    app = Flask(__name__); app.register_blueprint(bp)
    client = app.test_client(); client.set_cookie("session", key)
    watcher = app.test_client(); watcher.set_cookie("session", viewer_key)
    yield db, client, watcher, project, person, car, alien
    db.delete(project); db.delete(foreign); db.commit(); db.delete(user); db.delete(viewer); db.commit(); db.close()


def listing(client, project):
    return client.get(f"/api/projects/{project.code}/classes").get_json()


def test_класс_без_тагов_и_с_тагами_из_своего_справочника(scene):
    db, client, _watcher, project, person, car, alien = scene
    got = listing(client, project)
    assert {c["name"]: c["tags"] for c in got["classes"]} == {"Человек": [], "Машина": []}
    assert got["class_tags"] == []

    res = client.patch(f"/api/projects/{project.code}/classes/{person.id}",
                       json={"tags": ["Люди", " подвижные  объекты ", "люди", ""]})
    assert res.status_code == 200
    assert [t["name"] for t in res.get_json()["tags"]] == ["Люди", "подвижные объекты"]

    # «Подвижные объекты» в другом регистре — тот же таг, не новый
    res = client.post(f"/api/projects/{project.code}/classes",
                      json={"name": "Велосипед", "tags": ["Подвижные объекты"]})
    assert res.status_code == 201
    assert [t["name"] for t in res.get_json()["tags"]] == ["подвижные объекты"]

    got = listing(client, project)
    assert {c["name"]: [t["name"] for t in c["tags"]] for c in got["classes"]} == {
        "Человек": ["Люди", "подвижные объекты"], "Машина": [], "Велосипед": ["подвижные объекты"]}
    assert [(t["name"], t["classes"]) for t in got["class_tags"]] == [("Люди", 1), ("подвижные объекты", 2)]
    mine = db.execute(select(ClassTag).where(ClassTag.project_id == project.id)).scalars().all()
    assert len(mine) == 2 and alien.id not in {t.id for t in mine}
    # Таги кадров сюда не попадают, и наоборот
    assert all(t["name"] != "Ночь" for t in got["class_tags"])
    assert client.get(f"/api/projects/{project.code}/tags").get_json()["tags"][0]["name"] == "Ночь"


def test_замена_снятие_переименование_и_удаление_тага(scene):
    db, client, _watcher, project, person, car, _alien = scene
    base = f"/api/projects/{project.code}"
    client.patch(f"{base}/classes/{person.id}", json={"tags": ["Люди", "Живые"]})
    client.patch(f"{base}/classes/{car.id}", json={"tags": ["Транспорт"]})
    # Без поля tags правка класса таги не трогает
    assert [t["name"] for t in client.patch(f"{base}/classes/{person.id}", json={"color": "#ff0000"}).get_json()["tags"]] == ["Живые", "Люди"]
    # Пустой список снимает все таги, справочник остаётся
    assert client.patch(f"{base}/classes/{person.id}", json={"tags": []}).get_json()["tags"] == []
    tags = {t["name"]: t for t in listing(client, project)["class_tags"]}
    assert {n: t["classes"] for n, t in tags.items()} == {"Живые": 0, "Люди": 0, "Транспорт": 1}

    res = client.patch(f"{base}/class-tags/{tags['Транспорт']['id']}", json={"name": "транспорт "})
    assert res.status_code == 200 and res.get_json()["name"] == "транспорт"
    assert client.patch(f"{base}/class-tags/{tags['Люди']['id']}", json={"name": "ТРАНСПОРТ"}).status_code == 409
    assert [t["name"] for t in next(c for c in listing(client, project)["classes"] if c["id"] == str(car.id))["tags"]] == ["транспорт"]

    res = client.delete(f"{base}/class-tags/{tags['Транспорт']['id']}")
    assert res.status_code == 200 and res.get_json()["classes_untagged"] == 1
    assert next(c for c in listing(client, project)["classes"] if c["id"] == str(car.id))["tags"] == []
    assert db.get(LabelClass, car.id) is not None
    # Удаление класса уносит только связи
    client.patch(f"{base}/classes/{car.id}", json={"tags": ["Живые"]})
    db.expire_all()
    assert db.execute(select(LabelClassTag).where(LabelClassTag.class_id == car.id)).scalars().all()
    db.delete(db.get(LabelClass, car.id)); db.commit()
    assert not db.execute(select(LabelClassTag).where(LabelClassTag.class_id == car.id)).scalars().all()
    assert [(t["name"], t["classes"]) for t in listing(client, project)["class_tags"]] == [("Живые", 0), ("Люди", 0)]


def test_отказы_и_права(scene):
    _db, client, watcher, project, person, _car, alien = scene
    base = f"/api/projects/{project.code}"
    assert client.patch(f"{base}/classes/{person.id}", json={"tags": "Люди"}).status_code == 400
    assert client.patch(f"{base}/classes/{person.id}", json={"tags": [1]}).status_code == 400
    assert client.patch(f"{base}/classes/{person.id}", json={"tags": ["я" * 65]}).status_code == 400
    assert client.patch(f"{base}/classes/{person.id}", json={"tags": [f"т{i}" for i in range(33)]}).status_code == 400
    assert listing(client, project)["class_tags"] == []
    # Чужой таг через этот проект не правится и не удаляется
    assert client.patch(f"{base}/class-tags/{alien.id}", json={"name": "Свои"}).status_code == 404
    assert client.delete(f"{base}/class-tags/{alien.id}").status_code == 404
    # Зритель видит таги, но не меняет
    client.patch(f"{base}/classes/{person.id}", json={"tags": ["Люди"]})
    tag = listing(watcher, project)["class_tags"][0]
    assert tag["name"] == "Люди"
    assert watcher.patch(f"{base}/classes/{person.id}", json={"tags": []}).status_code == 403
    assert watcher.patch(f"{base}/class-tags/{tag['id']}", json={"name": "Иные"}).status_code == 403
    assert watcher.delete(f"{base}/class-tags/{tag['id']}").status_code == 403
