"""API и целостность переноса на отдельной тестовой PostgreSQL, без общего стенда."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

test_url = os.environ.get("TEST_TRANSFER_DATABASE_URL")
if not test_url:
    pytest.skip("Для проверки нужна отдельная TEST_TRANSFER_DATABASE_URL", allow_module_level=True)
assert os.environ.get("DATABASE_URL") == test_url

from flask import Flask
from sqlalchemy import func, select
from common.auth import hash_token
from common.db import Base, SessionLocal, engine
from common.models import (Annotation, AuthSession, DataprepJob, Dataset, Image, ImageTag,
                           LabelClass, Project, ProjectMember, Tag, Task, TrainSet, TrainSetSplit, User)
from datasets_svc.project_routes import bp


@pytest.fixture(scope="session", autouse=True)
def schema():
    Base.metadata.create_all(engine)


@pytest.fixture
def data():
    db = SessionLocal()
    suffix = uuid.uuid4().hex
    user = User(email=f"{suffix}@example.test", login=suffix, password_hash="test", display_name="Тест")
    project = Project(name="Тест", code=suffix[:20])
    db.add_all([user, project])
    db.flush()
    db.add_all([ProjectMember(project_id=project.id, user_id=user.id, role="admin"),
                AuthSession(user_id=user.id, token_hash=hash_token(suffix),
                            expires_at=datetime.now(timezone.utc) + timedelta(days=1))])
    src = Dataset(project_id=project.id, name="Источник", identifier="src")
    dst = Dataset(project_id=project.id, name="Приёмник", identifier="dst")
    db.add_all([src, dst]); db.flush()
    images = [Image(project_id=project.id, dataset_id=src.id, file_name=f"{i}.jpg",
                    file_path=f"images/{i}.jpg", split="val", task_status="annotated") for i in range(2)]
    cls = LabelClass(project_id=project.id, class_index=0, name="Вагон", color="#e5484d")
    tag = Tag(project_id=project.id, name="Ночь")
    db.add_all([*images, cls, tag]); db.flush()
    ann = Annotation(image_id=images[0].id, class_id=cls.id, ann_type="bbox",
                     geometry={"x": 1, "y": 2, "w": 3, "h": 4})
    db.add_all([ann, ImageTag(image_id=images[0].id, tag_id=tag.id)]); db.commit()
    app = Flask(__name__); app.register_blueprint(bp)
    client = app.test_client(); client.set_cookie("session", suffix)
    yield db, client, project, src, dst, images, ann, tag, user
    db.close()


def call(d, action, **body):
    _, client, project, src, dst, *_ = d
    return client.post(f"/api/projects/{project.code}/datasets/{src.id}/{action}",
                       json={"target_dataset_id": str(dst.id), **body})


def test_move_preserves_identity_annotations_tags_and_split(data):
    db, _, _, src, dst, images, ann, tag, _ = data
    response = call(data, "move", image_ids=[str(images[0].id)])
    assert response.status_code == 200 and response.json["moved"] == 1
    db.expire_all()
    moved = db.get(Image, images[0].id)
    assert (moved.dataset_id, moved.split, moved.file_path) == (dst.id, "val", "images/0.jpg")
    assert db.get(Image, images[1].id).dataset_id == src.id
    assert db.get(Annotation, ann.id).geometry == {"x": 1, "y": 2, "w": 3, "h": 4}
    assert db.get(ImageTag, (images[0].id, tag.id)) is not None


def test_move_rejects_stale_ids_atomically_across_batches(data):
    db, _, project, src, dst, images, *_ = data
    extra = [Image(project_id=project.id, dataset_id=src.id, file_name=f"extra-{i}.jpg",
                   file_path=f"extra/{i}.jpg") for i in range(999)]
    db.add_all(extra); db.commit()
    ids = [str(im.id) for im in images + extra] + ["ffffffff-ffff-ffff-ffff-ffffffffffff"]
    response = call(data, "move", image_ids=ids)
    assert response.status_code == 409
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Image).where(Image.dataset_id == src.id)) == 1001
    assert db.scalar(select(func.count()).select_from(Image).where(Image.dataset_id == dst.id)) == 0


def test_move_rejects_foreign_dataset_and_invalid_selection(data):
    db, _, project, src, _, images, *_ = data
    other = Project(name="Чужой", code=uuid.uuid4().hex[:20]); db.add(other); db.flush()
    foreign = Dataset(project_id=other.id, name="Чужой", identifier="foreign"); db.add(foreign); db.commit()
    assert call(data, "move", target_dataset_id=str(foreign.id), image_ids=[str(images[0].id)]).status_code == 404
    assert call(data, "move", target_dataset_id=str(src.id), image_ids=[str(images[0].id)]).status_code == 400
    assert call(data, "move", image_ids=["not-uuid"]).status_code == 400
    assert call(data, "move", image_ids=[]).status_code == 400
    db.expire_all(); assert db.get(Image, images[0].id).dataset_id == src.id


def test_held_frames_and_unfinished_sets_block_changes(data):
    db, _, project, src, _, images, *_ = data
    task = Task(project_id=project.id, name="Работа", status="in_progress")
    db.add(task); db.flush()
    db.add(Image(project_id=project.id, task_id=task.id, origin_image_id=images[0].id,
                 file_name="copy.jpg", file_path="copy.jpg")); db.commit()
    assert call(data, "move", image_ids=[str(images[0].id)]).status_code == 409
    assert call(data, "merge").json["code"] == "dataset_held"
    task.status = "closed"; db.commit()
    trainset = TrainSet(project_id=project.id, name="Набор", kind="bbox", status="draft",
                        spec={"datasets": [str(src.id)]}, split_mode="balanced", val_ratio=0.2,
                        seed=0)
    db.add(trainset); db.commit()
    assert call(data, "merge").json["code"] == "dataset_in_sets"
    db.expire_all(); assert db.get(Image, images[0].id).dataset_id == src.id


def test_merge_preserves_images_restore_references_and_closed_task(data):
    db, _, project, src, dst, images, ann, tag, _ = data
    task = Task(project_id=project.id, name="Завершена", status="closed", target_dataset_id=src.id)
    rejected = Image(project_id=project.id, file_name="deleted.jpg", file_path="deleted.jpg",
                     dataset_before_delete=src.id, status_before_delete="annotated", task_status="deleted")
    existing = Image(project_id=project.id, dataset_id=dst.id, file_name="existing.jpg", file_path="existing.jpg")
    built = TrainSet(project_id=project.id, name="Готовый набор", kind="bbox", status="ready",
                     spec={"datasets": [str(src.id)]}, split_mode="balanced", val_ratio=0.2, seed=0)
    db.add_all([task, rejected, existing, built]); db.flush()
    db.add(TrainSetSplit(set_id=built.id, image_id=images[0].id, split="val")); db.commit()
    source_id = src.id
    response = call(data, "merge")
    assert response.status_code == 200 and response.json["moved"] == 2
    db.expire_all()
    assert db.get(Dataset, source_id) is None
    assert all(db.get(Image, im.id).dataset_id == dst.id for im in images)
    assert db.get(Image, existing.id).dataset_id == dst.id
    assert db.get(Image, rejected.id).dataset_before_delete == dst.id
    assert db.get(Task, task.id).target_dataset_id == dst.id
    assert db.get(Annotation, ann.id) and db.get(ImageTag, (images[0].id, tag.id))
    assert db.get(TrainSetSplit, (built.id, images[0].id)).split == "val"


def test_permissions_and_active_preparation(data):
    db, client, project, src, _, images, _, _, user = data
    membership = db.scalar(select(ProjectMember).where(ProjectMember.project_id == project.id,
                                                       ProjectMember.user_id == user.id))
    membership.role = "viewer"; db.commit()
    assert call(data, "move", image_ids=[str(images[0].id)]).status_code == 403
    membership.role = "editor"; db.commit()
    assert call(data, "merge").status_code == 403
    job = DataprepJob(project_id=project.id, kind="embed", target_id=uuid.uuid4(), status="queued")
    db.add(job); db.commit()
    assert call(data, "move", image_ids=[str(images[0].id)]).json["code"] == "project_busy"
    client.delete_cookie("session")
    assert call(data, "merge").status_code == 401
