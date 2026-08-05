"""ORM models for the whole application, one class per entity of the agreed
schema. Deletion rules are encoded in the FK ondelete actions:

  project     -> CASCADE everything project-scoped (datasets, images,
                 annotations, classes, superclasses, memberships)
  dataset     -> CASCADE its images (and, via images, their annotations)
  image       -> CASCADE its annotations
  class       -> CASCADE its annotations
  superclass  -> SET NULL on classes.superclass_id (nothing is deleted)
  annotation  -> deletes nothing
  user        -> CASCADE memberships/sessions; created_by references SET NULL
                 so the audit trail survives

Every entity carries the audit pair created_at / created_by.
"""
import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from common.db import Base

# Portable JSON: JSONB on PostgreSQL, plain JSON elsewhere (tests).
JsonCol = sa.JSON().with_variant(JSONB(), "postgresql")

ROLE_ENUM = sa.Enum("admin", "editor", "viewer", name="project_role")
ANN_TYPE_ENUM = sa.Enum("bbox", "obb", "polygon", "mask", name="annotation_type")
# A project is "importing" from the moment the wizard creates it until the
# archive is written; the UI refuses tasks and export while it is.
PROJECT_STATUS_ENUM = sa.Enum("importing", "ready", name="project_status")
# Role of an image in training. Kept in the DB, not in the file path, so
# re-splitting is a column update instead of moving files around.
SPLIT_ENUM = sa.Enum("train", "val", "test", "other", name="image_split")
# Жизнь таски. «updating» — возврат к уже принятым кадрам: они остаются в
# проекте и правятся на месте. «closed» — черновики убраны, работа окончена.
TASK_STATUS_ENUM = sa.Enum(
    "queued", "in_progress", "done", "updating", "closed", name="task_status"
)
# Состояние кадра внутри таски. Все, кроме «new», — осознанное решение
# разметчика: «skipped» вернуться позже, «empty» объектов нет (уходит в датасет
# фоновым примером), «deleted» кадр забракован (dataset_id снимается, файлы
# стираются при закрытии таски).
IMAGE_TASK_STATUS_ENUM = sa.Enum(
    "new", "skipped", "annotated", "empty", "deleted", name="image_task_status"
)
# Кто нарисовал бокс. created_by для этого не годится: там пусто и у машинной
# разметки, и у осиротевшей после удаления пользователя.
ANN_SOURCE_ENUM = sa.Enum("human", "model", name="annotation_source")
FRIENDSHIP_STATUS_ENUM = sa.Enum("pending", "accepted", name="friendship_status")
INVITATION_STATUS_ENUM = sa.Enum(
    "pending", "accepted", "declined", name="invitation_status"
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class AuditMixin:
    """created_at / created_by present on every entity (log info)."""

    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )

    @sa.orm.declared_attr
    def created_by(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(
            sa.Uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        )


class User(Base, AuditMixin):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(sa.String(255), unique=True, nullable=False)
    login: Mapped[str] = mapped_column(sa.String(64), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    is_active: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, default=True)
    # Set when the confirmation link from the registration email is opened;
    # login is refused while it is NULL.
    email_confirmed_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )
    # Touched by authenticated API traffic; "online" = younger than 2 minutes.
    last_seen_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )

    memberships: Mapped[list["ProjectMember"]] = relationship(
        back_populates="user",
        foreign_keys="ProjectMember.user_id",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Project(Base, AuditMixin):
    __tablename__ = "projects"
    # Lets images carry a composite FK (dataset_id, project_id) further down.
    # Код выдаёт только сервер (auth_svc/core.py), поэтому длина закреплена в БД.
    __table_args__ = (
        sa.UniqueConstraint("code", name="uq_projects_code"),
        sa.CheckConstraint("char_length(code) = 20", name="ck_projects_code_len"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    code: Mapped[str] = mapped_column(sa.String(20), nullable=False)
    description: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    status: Mapped[str] = mapped_column(
        PROJECT_STATUS_ENUM, nullable=False, default="ready", server_default="ready"
    )

    members: Mapped[list["ProjectMember"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )


class ProjectMember(Base, AuditMixin):
    __tablename__ = "project_members"
    __table_args__ = (
        sa.UniqueConstraint("project_id", "user_id", name="uq_member_per_project"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(ROLE_ENUM, nullable=False)

    project: Mapped[Project] = relationship(back_populates="members")
    user: Mapped[User] = relationship(
        back_populates="memberships", foreign_keys=[user_id]
    )


class Dataset(Base, AuditMixin):
    __tablename__ = "datasets"
    __table_args__ = (
        sa.UniqueConstraint("project_id", "identifier", name="uq_dataset_identifier"),
        # Target for the composite FK on images that guarantees an image's
        # project always matches its dataset's project.
        sa.UniqueConstraint("id", "project_id", name="uq_dataset_id_project"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    identifier: Mapped[str] = mapped_column(sa.String(128), nullable=False)


class Image(Base, AuditMixin):
    __tablename__ = "images"
    __table_args__ = (
        sa.ForeignKeyConstraint(
            ["dataset_id", "project_id"],
            ["datasets.id", "datasets.project_id"],
            ondelete="CASCADE",
            name="fk_image_dataset_project",
        ),
        sa.Index("ix_images_dataset", "dataset_id"),
        sa.Index("ix_images_project", "project_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    # Пусто, пока кадр лежит в таске: он ещё не принадлежит проекту как данные.
    # Составной ключ (dataset_id, project_id) это переживает — в Postgres
    # ограничение не проверяется, если хоть одна колонка ссылки пуста.
    dataset_id: Mapped[uuid.UUID | None] = mapped_column(sa.Uuid, nullable=True)
    # Name inside the source archive; the file on disk is named by id.
    file_name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    # Binary lives on the shared yolo-data volume; the DB stores the path.
    file_path: Mapped[str] = mapped_column(sa.String(1024), nullable=False)
    split: Mapped[str] = mapped_column(
        SPLIT_ENUM, nullable=False, default="other", server_default="other"
    )
    # Откуда кадр пришёл. Ставится при загрузке и НЕ снимается при принятии:
    # таска — это происхождение кадра, датасет — его текущая принадлежность.
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True
    )
    task_status: Mapped[str] = mapped_column(
        IMAGE_TASK_STATUS_ENUM, nullable=False, default="new", server_default="new"
    )
    # Кадр из видео помнит источник и секунду: по одному кадру не всегда
    # понятно, что происходит, а «2:14 такого-то ролика» объясняет.
    source_video_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("task_videos.id", ondelete="SET NULL"), nullable=True
    )
    source_time_ms: Mapped[int | None] = mapped_column(sa.Integer)
    width: Mapped[int | None] = mapped_column(sa.Integer)
    height: Mapped[int | None] = mapped_column(sa.Integer)
    size_bytes: Mapped[int | None] = mapped_column(sa.BigInteger)


class Superclass(Base, AuditMixin):
    __tablename__ = "superclasses"

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    color: Mapped[str] = mapped_column(sa.String(7), nullable=False)  # #RRGGBB


class LabelClass(Base, AuditMixin):
    __tablename__ = "classes"
    __table_args__ = (
        sa.UniqueConstraint("project_id", "class_index", name="uq_class_index"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    superclass_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("superclasses.id", ondelete="SET NULL"), nullable=True
    )
    # Numeric id used in YOLO/COCO exports, unique inside the project.
    class_index: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    name: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    color: Mapped[str] = mapped_column(sa.String(7), nullable=False)


class Annotation(Base, AuditMixin):
    __tablename__ = "annotations"
    __table_args__ = (
        sa.Index("ix_annotations_image", "image_id"),
        sa.Index("ix_annotations_class", "class_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    image_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("images.id", ondelete="CASCADE"), nullable=False
    )
    class_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("classes.id", ondelete="CASCADE"), nullable=False
    )
    ann_type: Mapped[str] = mapped_column(ANN_TYPE_ENUM, nullable=False)
    # Shape depends on ann_type:
    #   bbox    {x, y, w, h}                    (pixels, COCO convention)
    #   obb     {cx, cy, w, h, angle}
    #   polygon {points: [[x, y], ...]}
    #   mask    {rle: {size, counts}}           (COCO RLE)
    geometry: Mapped[dict] = mapped_column(JsonCol, nullable=False)
    area: Mapped[float | None] = mapped_column(sa.Float)
    iscrowd: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, default=False)
    attributes: Mapped[dict | None] = mapped_column(JsonCol)
    source: Mapped[str] = mapped_column(
        ANN_SOURCE_ENUM, nullable=False, default="human", server_default="human"
    )


class Task(Base, AuditMixin):
    """Долгоживущий пул кадров: загрузили, размечаем, готовое отдаём в проект.

    Целевой датасет выбирается один раз при создании, поэтому «готово» потом
    работает одной кнопкой без вопросов. Исполнитель может стать пустым, если
    человека убрали из проекта, — тогда таска ждёт нового.
    """

    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    status: Mapped[str] = mapped_column(
        TASK_STATUS_ENUM, nullable=False, default="queued", server_default="queued"
    )
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Куда уйдут принятые кадры. Пусто = создать датасет с именем таски при
    # первом «готово».
    target_dataset_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True
    )
    target_dataset_name: Mapped[str | None] = mapped_column(sa.String(255))

    assignee: Mapped[User | None] = relationship(foreign_keys=[assignee_id])


class TaskVideo(Base, AuditMixin):
    """Исходник, из которого нарезали кадры. Живёт, пока таска не закрыта:
    к нему возвращаются, чтобы дорезать участок поплотнее."""

    __tablename__ = "task_videos"

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    task_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False
    )
    file_name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(sa.String(1024), nullable=False)
    duration_ms: Mapped[int | None] = mapped_column(sa.Integer)
    fps: Mapped[float | None] = mapped_column(sa.Float)
    width: Mapped[int | None] = mapped_column(sa.Integer)
    height: Mapped[int | None] = mapped_column(sa.Integer)
    size_bytes: Mapped[int | None] = mapped_column(sa.BigInteger)
    # План нарезки: [{start_ms, end_ms, step_ms}]. Именно план, а не история —
    # кадры таски приводятся к нему, поэтому он перезаписывается целиком.
    # Одиночный кадр — участок длиной в миллисекунду.
    segments: Mapped[list | None] = mapped_column(JsonCol)


class TaskEvent(Base):
    """Крупные события таски: смены состояний, загрузки, принятия, удаления.

    Отдельные боксы сюда не пишутся — у каждой аннотации уже есть автор и
    время, а тысяча строк «добавлен бокс» утопила бы всё остальное.
    """

    __tablename__ = "task_events"
    __table_args__ = (sa.Index("ix_task_events_task", "task_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    task_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    kind: Mapped[str] = mapped_column(sa.String(48), nullable=False)
    payload: Mapped[dict | None] = mapped_column(JsonCol)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )

    user: Mapped[User | None] = relationship()


class EmailConfirmation(Base):
    """One-shot token behind the confirmation link sent at registration.
    Only the SHA-256 of the token is stored; rows expire after 24 h."""

    __tablename__ = "email_confirmations"

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(sa.String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )


class Friendship(Base):
    """Friend link: requester sends, addressee accepts (pending -> accepted).
    Declining deletes the row; one row per pair regardless of direction."""

    __tablename__ = "friendships"
    __table_args__ = (
        sa.UniqueConstraint("requester_id", "addressee_id", name="uq_friend_pair"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    requester_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    addressee_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(FRIENDSHIP_STATUS_ENUM, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )

    requester: Mapped[User] = relationship(foreign_keys=[requester_id])
    addressee: Mapped[User] = relationship(foreign_keys=[addressee_id])


class ProjectInvitation(Base, AuditMixin):
    """Invitation to join a project with a role; created_by is the inviter.
    Accepting creates the project_members row; the invitation keeps history."""

    __tablename__ = "project_invitations"
    __table_args__ = (
        sa.UniqueConstraint("project_id", "user_id", name="uq_invitation_target"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(ROLE_ENUM, nullable=False)
    status: Mapped[str] = mapped_column(
        INVITATION_STATUS_ENUM, nullable=False, default="pending"
    )

    project: Mapped[Project] = relationship()
    user: Mapped[User] = relationship(foreign_keys=[user_id])


class AuthSession(Base):
    """Server-side session backing the httpOnly cookie. The cookie carries a
    random token; only its SHA-256 hash is stored."""

    __tablename__ = "auth_sessions"

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(
        sa.String(64), unique=True, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )
    expires_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False
    )

    user: Mapped[User] = relationship()
