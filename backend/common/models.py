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
# Что делают с загруженным роликом. Выбирается один раз при загрузке и больше
# не меняется: «cut» — нарезаем кадры и размечаем их, «annotate» — размечаем
# сам ролик по кадрам, а кадры появляются при сдаче таски.
VIDEO_MODE_ENUM = sa.Enum("cut", "annotate", name="video_mode")
# Готовность ступени качества: файла копии и набора перегонов.
VIDEO_ASSET_STATUS_ENUM = sa.Enum(
    "pending", "building", "ready", "error", name="video_asset_status"
)
# Что за работа над роликом. «index» — таблица кадров, без неё ролик не
# открыть; «strip» — кинолента под таймлайн; «variant» — полная копия
# ступени; «chunkset» — все перегоны ступени; «chunk» — один перегон,
# которого прямо сейчас ждёт разметчик.
VIDEO_JOB_KIND_ENUM = sa.Enum(
    "index", "strip", "variant", "chunkset", "chunk", name="video_job_kind"
)
VIDEO_JOB_STATUS_ENUM = sa.Enum(
    "queued", "running", "done", "error", name="video_job_status"
)
FRIENDSHIP_STATUS_ENUM = sa.Enum("pending", "accepted", name="friendship_status")
INVITATION_STATUS_ENUM = sa.Enum(
    "pending", "accepted", "declined", name="invitation_status"
)
# Вид разметки в обучающем наборе. Своё перечисление, а не ANN_TYPE_ENUM:
# «obb» и «mask» в набор не пойдут никогда, и запрещать это должна база, а не
# комментарий рядом с проверкой.
TRAIN_SET_KIND_ENUM = sa.Enum("bbox", "polygon", name="train_set_kind")
# «deleting» ставится до того, как воркер тронет папку: список видит
# удаление сразу, а не после того, как оно удалось или не удалось.
TRAIN_SET_STATUS_ENUM = sa.Enum(
    "draft", "queued", "building", "ready", "error", "deleting",
    name="train_set_status",
)
# Чем поделили набор на обучающую и проверочную части. «balanced» — случайно,
# но с оглядкой на редкие классы; «smart» — по группам похожих кадров.
SPLIT_MODE_ENUM = sa.Enum(
    "manual", "random", "balanced", "smart", name="split_mode"
)
# Работа очереди подготовки данных. «embed» считает признаки кадров и потому
# уезжает на видеокарту — её берёт воркер обучения, а не воркер подготовки:
# torch стоит в одном образе, а не в двух.
DATAPREP_KIND_ENUM = sa.Enum(
    "build_set", "embed", "delete_set", name="dataprep_job_kind"
)
DATAPREP_STATUS_ENUM = sa.Enum(
    "queued", "running", "done", "error", "cancelled", name="dataprep_job_status"
)
TRAIN_TASK_ENUM = sa.Enum("detect", "segment", name="train_task")
# Жизнь обучения. «waiting_gpu» отделено от «queued» нарочно: человеку нужно
# знать, ждёт ли он своей очереди вообще или конкретно памяти на карте —
# во втором случае помогает уменьшить батч, в первом ничего не помогает.
TRAIN_RUN_STATUS_ENUM = sa.Enum(
    "queued", "waiting_gpu", "preparing", "running", "stopping",
    "done", "error", "stopped", name="train_run_status",
)
CHECK_STATUS_ENUM = sa.Enum(
    "queued", "waiting_gpu", "running", "done", "error", "stopped",
    name="model_check_status",
)
# Бронь памяти на карте. «denied» — отказ навсегда (карт нет вовсе, а работа
# без карты не идёт); «queued» — ждём, места сейчас нет.
GPU_LEASE_STATUS_ENUM = sa.Enum(
    "queued", "held", "released", "expired", "denied", "cancelled",
    name="gpu_lease_status",
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
    # Право на железо, а не на данные. Ролей в проекте для этого не хватает:
    # администратор своего проекта не должен снимать чужое обучение с карты.
    # Один бит, а не справочник глобальных ролей — право пока ровно одно, и
    # машинерию под него пришлось бы объяснять на пустом месте.
    is_staff: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, default=False, server_default=sa.false()
    )
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
        # Поиск «есть ли уже изображение для этого кадра» при повторной сдаче.
        sa.Index("ix_images_video_frame", "source_video_id", "source_frame_no"),
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
    # Номер кадра — только у кадров, материализованных из размечаемого видео.
    # По нему повторная сдача находит уже созданное изображение и правит его,
    # а не плодит второй экземпляр того же кадра. У нарезки он пуст: там кадр
    # адресуется временем, и попасть точно в тот же кадр нарезка не обещает.
    source_frame_no: Mapped[int | None] = mapped_column(sa.Integer)
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
    #   polygon {parts: [[[x, y], ...], ...]}   (pixels; see below)
    #   mask    {rle: {size, counts}}           (COCO RLE)
    #
    # У полигона частей несколько, а не одна: объект бывает разорван — вагон
    # за стойкой виден двумя половинами, — и обводка обязана показывать то же,
    # что охватывает рамка. Части разъединены, отверстий среди них нет: SAM2
    # отдаёт куски маски (RETR_EXTERNAL), а формат, в который мы выгружаем,
    # отверстий не знает. Работа с ними — `common/polygon.py`.
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
    # Что с роликом делают. Решается при загрузке и не меняется: от режима
    # зависит и хранение разметки, и то, откуда в проекте берутся кадры.
    mode: Mapped[str] = mapped_column(
        VIDEO_MODE_ENUM, nullable=False, default="cut", server_default="cut"
    )
    # Сколько всего кадров. Нужен размечаемому видео: таймлайн ходит по
    # номерам кадров, а не по секундам, иначе «тот самый кадр» не адресуется.
    # У размечаемого ролика это точное число из таблицы кадров, а не оценка.
    frame_count: Mapped[int | None] = mapped_column(sa.Integer)
    # Отпечаток таблицы кадров. Сама таблица лежит файлом рядом с роликом —
    # десятки тысяч чисел в строке БД не ищутся и не соединяются. Отпечаток
    # нужен, чтобы отказать плану разметки, посчитанному по другой нумерации.
    index_version: Mapped[str | None] = mapped_column(sa.String(32))
    # Когда разметку ролика закрыли и превратили в кадры таски. Пусто — она
    # ещё в работе. Материализация — событие, а не вечная синхронизация:
    # созданные кадры дальше живут как обычные и никем не переписываются.
    annotation_closed_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )
    # Кадры, помеченные фоновыми: объектов на них нет, и в датасет они уйдут
    # отрицательными примерами со статусом «empty» — тем же, что ставит рукой
    # разметчик изображений. Держим списком номеров прямо здесь: пометок
    # единицы, ставятся они по одной, и отдельная таблица ради этого только
    # добавила бы соединение к каждому чтению разметки.
    #
    # Пометка на кадре, где всё-таки есть объект, не действует, но и не
    # стирается: трек могли продлить по ошибке, и молча терять работу руками
    # из-за этого неправильно. Решает присутствие объекта в момент выгрузки.
    empty_frames: Mapped[list | None] = mapped_column(JsonCol)
    # План нарезки: [{start_ms, end_ms, step_ms}]. Именно план, а не история —
    # кадры таски приводятся к нему, поэтому он перезаписывается целиком.
    # Одиночный кадр — участок длиной в миллисекунду.
    segments: Mapped[list | None] = mapped_column(JsonCol)
    # Сама таблица кадров: {first_pts, deltas, keys, time_base, rate, …}.
    # Раньше она лежала файлом рядом с роликом — «девяносто тысяч чисел в
    # строке БД не ищутся и не соединяются». Это по-прежнему верно, но цена
    # оказалась выше: каждый запрос перегона читал файл с тома и разворачивал
    # дельты заново. Теперь таблица живёт здесь и разворачивается один раз на
    # процесс (``video_index``), а том перестаёт быть носителем состояния.
    frame_index: Mapped[dict | None] = mapped_column(JsonCol)


class VideoAsset(Base, AuditMixin):
    """Ступень качества ролика: полная копия и нарезанные из неё перегоны.

    Копия — не украшение. Перегон, вырезанный из копии 480p, стоит
    перекладывания пакетов: копия пишется с опорным кадром ровно на границе
    каждого перегона, поэтому кусок берётся без разжатия и сжатия заново.
    Из оригинала 2688×1520 тот же перегон стоил бы полного перекодирования.

    Исходное качество копии не имеет — оно и есть оригинал; его перегоны
    режутся перекодированием и только по требованию.
    """

    __tablename__ = "video_assets"
    __table_args__ = (
        sa.UniqueConstraint("video_id", "quality", name="uq_video_asset_quality"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    video_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("task_videos.id", ondelete="CASCADE"), nullable=False
    )
    # «src» или высота ступени строкой: «1080», «720», «480».
    quality: Mapped[str] = mapped_column(sa.String(16), nullable=False)

    # Полная копия ступени. Путь хранится, а не вычисляется: файл появляется
    # фоновой задачей, и по наличию пути в базе видно, что она дошла до конца.
    file_status: Mapped[str] = mapped_column(
        VIDEO_ASSET_STATUS_ENUM, nullable=False,
        default="pending", server_default="pending",
    )
    file_path: Mapped[str | None] = mapped_column(sa.String(1024))
    width: Mapped[int | None] = mapped_column(sa.Integer)
    height: Mapped[int | None] = mapped_column(sa.Integer)
    size_bytes: Mapped[int | None] = mapped_column(sa.BigInteger)

    # Перегоны этой ступени. Готовность — числом, а не обходом каталога:
    # у часового ролика перегонов под тысячу, и `os.path.exists` по ним на
    # каждый запрос стоил дороже самого ответа.
    chunks_status: Mapped[str] = mapped_column(
        VIDEO_ASSET_STATUS_ENUM, nullable=False,
        default="pending", server_default="pending",
    )
    chunks_dir: Mapped[str | None] = mapped_column(sa.String(1024))
    chunks_ready: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    chunks_total: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )

    error: Mapped[str | None] = mapped_column(sa.Text)
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )


class VideoJob(Base):
    """Очередь тяжёлой работы над роликом.

    Очередь лежит в базе, а не в памяти процесса, по трём причинам, и каждая
    уже стоила крови. Она переживает перезапуск воркера — иначе ролик,
    застигнутый рестартом, оставался бы недорезанным навсегда. Её видят все
    процессы разом — иначе два воркера молотили бы одну и ту же ступень.
    И у неё есть память об отказе — иначе битый ролик заводил бы новую нарезку
    на каждое движение разметчика по таймлайну.

    Взятие задачи — ``FOR UPDATE SKIP LOCKED``: воркеры не ждут друг друга и
    не берут одно и то же.
    """

    __tablename__ = "video_jobs"
    __table_args__ = (
        # Повтор одной и той же работы отсекается на уровне базы, а не
        # проверкой перед вставкой: между проверкой и вставкой помещается
        # второй такой же запрос.
        sa.Index(
            "uq_video_job_active",
            "video_id", "kind", "quality", "chunk_no",
            unique=True,
            postgresql_where=sa.text("status IN ('queued', 'running')"),
        ),
        sa.Index("ix_video_jobs_pick", "status", "priority", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    video_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("task_videos.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(VIDEO_JOB_KIND_ENUM, nullable=False)
    # Пустая строка и −1 значат «эта работа не про качество / не про перегон».
    # Пустые значения вместо NULL нужны уникальному индексу: в PostgreSQL два
    # NULL считаются разными, и повторы проходили бы насквозь.
    quality: Mapped[str] = mapped_column(
        sa.String(16), nullable=False, default="", server_default=""
    )
    chunk_no: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=-1, server_default="-1"
    )
    priority: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=50)
    status: Mapped[str] = mapped_column(
        VIDEO_JOB_STATUS_ENUM, nullable=False,
        default="queued", server_default="queued",
    )
    attempts: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    error: Mapped[str | None] = mapped_column(sa.Text)
    # Докуда задача считается живой. Воркер продлевает срок, пока работает;
    # просроченная возвращается в очередь — так падение воркера посреди
    # нарезки не оставляет задачу в «running» навсегда.
    lease_until: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    progress: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    total: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )
    started_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))


class VideoTrack(Base, AuditMixin):
    """Объект, живущий во времени: появился на кадре, пропал на другом.

    Трек-бокс — второй инструмент редактора рядом с обычным боксом. Обычный
    принадлежит одному кадру, трек тянется от кадра появления до кадра, где
    его убрали, и между ключевыми кадрами считается сам.
    """

    __tablename__ = "video_tracks"
    __table_args__ = (sa.Index("ix_video_tracks_video", "video_id"),)

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    video_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("task_videos.id", ondelete="CASCADE"), nullable=False
    )
    class_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("classes.id", ondelete="CASCADE"), nullable=False
    )
    # Кадр появления и кадр, на котором трек убрали. Пустой конец — «ещё не
    # убран», трек живёт до последнего кадра ролика.
    start_frame: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    end_frame: Mapped[int | None] = mapped_column(sa.Integer)
    # Считать ли положение между ключевыми кадрами. Выключено — бокс стоит на
    # месте последнего ключевого до следующего.
    interpolate: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, default=True, server_default=sa.true()
    )
    # Каждый N-й кадр трека уходит в проект при сдаче таски. Задаётся у трека:
    # быстрый объект выгружают часто, медленный — редко.
    export_step: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=1, server_default="1"
    )
    # Подпись в списке объектов редактора: «вагон #3». Не обязательна.
    label: Mapped[str | None] = mapped_column(sa.String(64))
    # Отрезки [от, до), на которых объект заслонён: он есть, но в разметку не
    # идёт. Отрезки, а не флаг у ключа: разметчик тянет их за края мышью, и
    # край обязан быть собственной сущностью, иначе жест двигал бы и бокс.
    hidden_ranges: Mapped[list | None] = mapped_column(
        JsonCol, nullable=False, default=list, server_default="[]"
    )


class VideoAnnotation(Base, AuditMixin):
    """Бокс на конкретном кадре размечаемого видео.

    Пока таска не сдана, разметка видео живёт здесь, а не в ``annotations``:
    кадров как изображений ещё не существует. На сдаче нужные кадры
    извлекаются из ролика и разметка переезжает в обычные аннотации.

    У трека строки — это ключевые кадры: то, что разметчик поставил рукой.
    Промежуточные положения считаются из соседних ключевых, а заслонённые
    участки живут отрезками у самого трека.
    """

    __tablename__ = "video_annotations"
    __table_args__ = (
        # У трека на кадре ровно один бокс — иначе интерполяция неоднозначна.
        sa.UniqueConstraint("track_id", "frame_no", name="uq_track_frame"),
        sa.Index("ix_video_ann_video_frame", "video_id", "frame_no"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    video_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("task_videos.id", ondelete="CASCADE"), nullable=False
    )
    # Пусто — обычный одиночный бокс, живущий только на своём кадре.
    track_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("video_tracks.id", ondelete="CASCADE"), nullable=True
    )
    frame_no: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    class_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("classes.id", ondelete="CASCADE"), nullable=False
    )
    ann_type: Mapped[str] = mapped_column(
        ANN_TYPE_ENUM, nullable=False, default="bbox", server_default="bbox"
    )
    geometry: Mapped[dict] = mapped_column(JsonCol, nullable=False)
    source: Mapped[str] = mapped_column(
        ANN_SOURCE_ENUM, nullable=False, default="human", server_default="human"
    )


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


# =========================================================================== #
# Видеокарты: одна на всех, и делят её три контейнера
# =========================================================================== #
class GpuDevice(Base):
    """Карта, какой её увидел процесс, у которого есть torch и доступ к железу.

    Строка в базе, а не опрос драйвера на каждый запрос, по двум причинам.
    Карту делят ``training-worker``, ``autolabel`` и (через заказ признаков)
    ``dataprep`` — у них нет общей памяти, а решать про допуск они обязаны
    согласованно. И HTTP-сервис карт вообще не видит: он читает эту таблицу,
    поэтому экран железа отвечает даже когда воркер лежит, и честно пишет,
    как давно карта отзывалась.
    """

    __tablename__ = "gpu_devices"
    __table_args__ = (
        sa.UniqueConstraint("host", "device_index", name="uq_gpu_device_slot"),
        sa.Index("ix_gpu_devices_live", "enabled"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    host: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    device_index: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    # Настоящий ключ железки. Переставили карты местами — номер поменялся, а
    # это нет, и накопленные потолки остались при своей карте.
    uuid_str: Mapped[str | None] = mapped_column(sa.String(64), unique=True)
    name: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    total_mb: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    # Неприкосновенный запас: сколько памяти не раздавать никогда. Ставит
    # человек, перезапуск контейнера это не сбрасывает.
    reserved_mb: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=1024, server_default="1024"
    )
    # Постоянная бронь полуавтомата. Колонкой, а не строкой брони на сессию:
    # сессии SAM2 приходят и уходят десятками в час, а память процесс держит
    # всё время, пока жив хоть один его воркер.
    sam2_reserve_mb: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    # Сколько тяжёлых задач пускать на карту. Два обучения по памяти влезут, но
    # станут вдвое медленнее каждое, и оба человека решат, что сервер сломался.
    max_heavy: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=1, server_default="1"
    )
    enabled: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, default=True, server_default=sa.true()
    )
    seen_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )


class GpuLease(Base):
    """Бронь памяти на карте.

    Строка, а не счётчик у карты: счётчик нельзя просрочить. Процесс, убитый
    посреди обучения, унёс бы память навсегда, и карта осталась бы занятой
    призраком. У строки есть ``lease_until``, и через срок аренды она
    возвращается сама — тот же приём, что у ``VideoJob``, и там он уже
    доказал, что работает.
    """

    __tablename__ = "gpu_leases"
    __table_args__ = (
        sa.Index("ix_gpu_leases_held", "device_id", "status"),
        sa.Index("ix_gpu_leases_queue", "queue_priority", "created_at"),
        sa.Index("ix_gpu_leases_ref", "ref_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    # Пусто у брони, которая ещё стоит в очереди, и у работы на процессоре.
    device_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("gpu_devices.id", ondelete="CASCADE")
    )
    holder: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    kind: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    # На что бронь: ран обучения, проверка модели, работа очереди подготовки.
    ref_id: Mapped[uuid.UUID | None] = mapped_column(sa.Uuid)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="SET NULL")
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="SET NULL")
    )
    want_mb: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    granted_mb: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    peak_mb: Mapped[int | None] = mapped_column(sa.Integer)
    status: Mapped[str] = mapped_column(
        GPU_LEASE_STATUS_ENUM, nullable=False,
        default="queued", server_default="queued",
    )
    queue_priority: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=50, server_default="50"
    )
    lease_until: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    # Почему стоим. Текст готов к показу человеку целиком: «карта 0: свободно
    # 2,1 ГБ из нужных 6,4». Молчаливое ожидание — худший ответ из возможных.
    reason: Mapped[str | None] = mapped_column(sa.String(200))
    # Подпись задачи для чужих глаз в очереди: «Обучение «Вагоны · ночь v3»».
    title: Mapped[str | None] = mapped_column(sa.String(160))
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )
    granted_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    released_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))


class GpuUsageHint(Base):
    """Сколько памяти на самом деле съела такая же работа в прошлый раз.

    Оценка до запуска — догадка, и первая догадка всегда мимо. Замер по ходу
    превращает её в знание: следующая такая же тройка (модель, размер входа,
    батч) просит не по формуле, а по факту.

    ``high_mb`` растёт мгновенно и оседает медленно, и асимметрия нарочная:
    недооценка стоит нехватки памяти посреди трёхчасового обучения,
    переоценка — минут ожидания. Хвост дороже середины.
    """

    __tablename__ = "gpu_usage_hints"

    kind: Mapped[str] = mapped_column(sa.String(32), primary_key=True)
    # sha1 от того, что определяет расход: модель, задача, размер входа, батч.
    signature: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    samples: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    high_mb: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    last_mb: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )


# =========================================================================== #
# Графы аугментаций: принадлежат человеку, подключаются к проекту ссылкой
# =========================================================================== #
class AugGraph(Base, AuditMixin):
    """Граф аугментаций из личной библиотеки.

    Принадлежит человеку, а не проекту: удачный граф переносят из проекта в
    проект, и копия разошлась бы с оригиналом на первой же правке. В проект
    он попадает ссылкой (``project_aug_graphs``).

    Владелец может исчезнуть, а граф — нет: на его версии ссылаются собранные
    наборы, и обещание «набор откроет то, чем его собрали» должно пережить
    удаление учётной записи. Поэтому ``owner_id`` обнуляется, а не каскадит.
    """

    __tablename__ = "aug_graphs"
    __table_args__ = (
        sa.UniqueConstraint("owner_id", "name", name="uq_aug_graph_name"),
        sa.Index("ix_aug_graphs_owner", "owner_id", "archived_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="SET NULL")
    )
    name: Mapped[str] = mapped_column(sa.String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(sa.Text)
    # Текущая версия. Ссылка в обратную сторону, поэтому внешний ключ
    # создаётся отдельным ALTER: иначе две таблицы ссылаются друг на друга и
    # ни одну нельзя создать первой.
    head_version_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid,
        sa.ForeignKey("aug_graph_versions.id", ondelete="SET NULL", use_alter=True,
                      name="fk_aug_graph_head"),
    )
    archived_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))


class AugGraphVersion(Base, AuditMixin):
    """Снимок графа. После создания не меняется — правка рождает следующую.

    Версия адресуема, поэтому на неё ставится внешний ключ, и правило «версию,
    на которой учились, удалить нельзя» становится делом базы, а не обещанием
    кода. Историей внутри одной строки этого не добиться.

    ``digest`` уникален внутри графа нарочно: «сохранить» жмут рефлекторно, и
    без отпечатка за вечер накопится тридцать одинаковых версий, после чего
    запись «набор собран версией 7» перестанет что-либо значить. Считается по
    приведённому документу без координат узлов: подвинули узел мышью — смысл
    не поменялся.
    """

    __tablename__ = "aug_graph_versions"
    __table_args__ = (
        sa.UniqueConstraint("graph_id", "version", name="uq_aug_version_no"),
        sa.UniqueConstraint("graph_id", "digest", name="uq_aug_version_digest"),
        sa.Index("ix_aug_versions_graph", "graph_id", "version"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    graph_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("aug_graphs.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    doc: Mapped[dict] = mapped_column(JsonCol, nullable=False)
    digest: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    # Что посчитано по графу заранее: во сколько раз он множит поток и сколько
    # в нём узлов. Список графов показывает «×6», не разворачивая документ.
    stats: Mapped[dict | None] = mapped_column(JsonCol)
    # Имена гнёзд, когда граф вставляют в другой граф одним блоком.
    port_names: Mapped[dict | None] = mapped_column(
        JsonCol, nullable=False, default=lambda: {"in": [], "out": []},
        server_default='{"in": [], "out": []}',
    )
    note: Mapped[str | None] = mapped_column(sa.String(255))


class AugGraphUse(Base):
    """Ребро «эта версия вставляет в себя вот этот граф блоком».

    Отдельной таблицей, а не разбором документов, ради трёх вещей, каждая из
    которых иначе стоит обхода всех графов сразу: запрет колец обходом по
    рёбрам, ответ «граф нельзя убрать, его вставляет такой-то» и выборка всех
    вложенных версий одним запросом. ``RESTRICT`` не даёт блоку исчезнуть
    из-под того, кто на него ссылается.
    """

    __tablename__ = "aug_graph_uses"
    __table_args__ = (
        sa.UniqueConstraint("version_id", "used_version_id", name="uq_aug_use"),
        sa.Index("ix_aug_uses_used", "used_graph_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    version_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("aug_graph_versions.id", ondelete="CASCADE"),
        nullable=False,
    )
    used_graph_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("aug_graphs.id", ondelete="RESTRICT"), nullable=False
    )
    used_version_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("aug_graph_versions.id", ondelete="RESTRICT"),
        nullable=False,
    )


class ProjectAugGraph(Base, AuditMixin):
    """Граф, подключённый к проекту. Именно ссылка, а не копия."""

    __tablename__ = "project_aug_graphs"

    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    graph_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("aug_graphs.id", ondelete="CASCADE"), primary_key=True
    )


# =========================================================================== #
# Обучающие наборы
# =========================================================================== #
class TrainSet(Base, AuditMixin):
    """Собранный набор: папка на томе плюс её паспорт.

    ``spec`` — снимок всего, что человек выбрал в мастере. Снимком, а не
    колонками, потому что параметры мастера будут расти, а набор живёт вечно:
    собранное год назад обязано читаться сегодня. Колонками вынесено ровно то,
    по чему ищут и сортируют, и то, что держит ссылочную целостность.

    Кадры набора построчно здесь не лежат: набор из ста тысяч кадров при графе
    ×6 — это шестьсот тысяч строк, которые ни с чем не соединяются, дублируют
    содержимое папки и живут ровно столько же, сколько она. Их место —
    ``manifest.jsonl`` рядом с файлами. А вот деление в базе нужно, и оно про
    исходный кадр: см. ``TrainSetSplit``.
    """

    __tablename__ = "train_sets"
    __table_args__ = (
        sa.UniqueConstraint("project_id", "name", name="uq_train_set_name"),
        sa.Index("ix_train_sets_project", "project_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    kind: Mapped[str] = mapped_column(TRAIN_SET_KIND_ENUM, nullable=False)
    status: Mapped[str] = mapped_column(
        TRAIN_SET_STATUS_ENUM, nullable=False,
        default="draft", server_default="draft",
    )
    spec: Mapped[dict] = mapped_column(JsonCol, nullable=False)
    split_mode: Mapped[str] = mapped_column(SPLIT_MODE_ENUM, nullable=False)
    val_ratio: Mapped[float] = mapped_column(sa.Float, nullable=False)
    # Одно зерно на весь набор: и на деление, и на вероятностные развилки
    # графа. Одно число, которое человек видит и может переписать, — этого
    # достаточно, чтобы пересобрать точно так же.
    seed: Mapped[int] = mapped_column(sa.BigInteger, nullable=False)
    graph_version_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("aug_graph_versions.id", ondelete="RESTRICT")
    )
    val_graph_version_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("aug_graph_versions.id", ondelete="RESTRICT")
    )
    counts: Mapped[dict | None] = mapped_column(JsonCol)
    size_bytes: Mapped[int] = mapped_column(
        sa.BigInteger, nullable=False, default=0, server_default="0"
    )
    # Сколько байт легло жёсткими ссылками, то есть места не заняло. Без этой
    # строки «набор весит 40 ГБ» пугает впустую.
    hardlinked_bytes: Mapped[int] = mapped_column(
        sa.BigInteger, nullable=False, default=0, server_default="0"
    )
    dir_path: Mapped[str | None] = mapped_column(sa.String(1024))
    built_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(sa.Text)


class TrainSetSplit(Base):
    """Куда попал ИСХОДНЫЙ кадр — в обучение или в проверку.

    Строка на кадр, а не на образец: сто тысяч вместо шестисот. Нужна трижды,
    и каждый раз по делу: отчёт «класс → обучение/проверка» без чтения тома,
    следующий набор с тем же делением и проверка «кадр из val не оказался в
    train» без разбора манифеста.
    """

    __tablename__ = "train_set_splits"
    __table_args__ = (sa.Index("ix_set_splits_split", "set_id", "split"),)

    set_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("train_sets.id", ondelete="CASCADE"), primary_key=True
    )
    image_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("images.id", ondelete="CASCADE"), primary_key=True
    )
    split: Mapped[str] = mapped_column(SPLIT_ENUM, nullable=False)
    # Группа, которой кадр обязан своим местом: номер кластера у умного
    # деления, самый редкий класс у обычного. Нужна, чтобы объяснить решение.
    group_key: Mapped[str | None] = mapped_column(sa.String(64))


class ImageEmbedding(Base):
    """Признаки кадра: вектор, по которому кадры сходятся в группы.

    Хранится байтами, а не массивом чисел, потому что косинус мы в базе не
    считаем — вся близость считается одним умножением матриц в питоне, и
    индекс по вектору не нужен вовсе. Нужно только быстро отдать вектора
    выбранных кадров: сто тысяч по 768 байт — это 77 МБ одним запросом.

    Модель в ключе: сменим её — старые вектора не мешают и не требуют уборки.
    Кадр не меняется, поэтому вектор считается один раз и живёт вечно; второе
    деление того же проекта после этого мгновенно.
    """

    __tablename__ = "image_embeddings"
    __table_args__ = (sa.Index("ix_image_emb_model", "model"),)

    image_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("images.id", ondelete="CASCADE"), primary_key=True
    )
    model: Mapped[str] = mapped_column(sa.String(48), primary_key=True)
    dim: Mapped[int] = mapped_column(sa.SmallInteger, nullable=False)
    vector: Mapped[bytes] = mapped_column(sa.LargeBinary, nullable=False)
    # Длина вектора ДО нормализации: по ней видно пустые и вырожденные кадры.
    norm: Mapped[float] = mapped_column(sa.Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )


class DataprepJob(Base):
    """Очередь подготовки данных. Полная калька с ``VideoJob``.

    Та же аренда, тот же ``FOR UPDATE SKIP LOCKED``, те же попытки и та же
    память об отказе — приёмы уже проверены на видео, и заводить для них
    второй свод правил незачем. Своя таблица, а не общая с видео: у той своя
    цель и свой набор работ, и сращивание потребовало бы ссылки, которую база
    не проверит.

    ``cancel_requested`` — колонка, а не множество в памяти процесса: воркер
    живёт в отдельном контейнере, и послать ему что-либо, кроме записи в базу,
    нечем.
    """

    __tablename__ = "dataprep_jobs"
    __table_args__ = (
        sa.Index(
            "uq_dataprep_job_active", "kind", "target_id",
            unique=True,
            postgresql_where=sa.text("status IN ('queued', 'running')"),
        ),
        sa.Index("ix_dataprep_jobs_pick", "status", "priority", "created_at"),
        sa.Index("ix_dataprep_jobs_project", "project_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(DATAPREP_KIND_ENUM, nullable=False)
    # На что работа: набор, пачка кадров под признаки. Без внешнего ключа —
    # цель разного рода, и база такую ссылку всё равно не проверит.
    target_id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, nullable=False)
    payload: Mapped[dict | None] = mapped_column(JsonCol)
    priority: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=50, server_default="50"
    )
    status: Mapped[str] = mapped_column(
        DATAPREP_STATUS_ENUM, nullable=False,
        default="queued", server_default="queued",
    )
    attempts: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    error: Mapped[str | None] = mapped_column(sa.Text)
    lease_until: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    progress: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    total: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    stage: Mapped[str | None] = mapped_column(sa.String(24))
    # То же самое по-человечески: «считаю признаки», «складываю кадры».
    stage_text: Mapped[str | None] = mapped_column(sa.String(160))
    cancel_requested: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, default=False, server_default=sa.false()
    )
    worker_id: Mapped[str | None] = mapped_column(sa.String(64))
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )
    started_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="SET NULL")
    )


# =========================================================================== #
# Обучение
# =========================================================================== #
class TrainRun(Base, AuditMixin):
    """Обучение: что запустили, чем, где и чем кончилось.

    Состояние живёт в базе, а не в файле рядом с весами, ровно потому, что его
    обязан видеть любой процесс gunicorn. Пока оно лежало в памяти одного
    процесса, у сервиса стоял ``--workers 1``, и тридцать две открытые вкладки
    останавливали раздел всем.

    Набор удерживается ``RESTRICT``: обещание «повторить обучение ровно на том
    же» без набора превращается в слова.
    """

    __tablename__ = "train_runs"
    __table_args__ = (
        sa.Index("ix_train_runs_project", "project_id", "created_at"),
        sa.Index("ix_train_runs_set", "set_id"),
        sa.Index(
            "ix_train_runs_pick", "status", "created_at",
            postgresql_where=sa.text("status IN ('queued', 'waiting_gpu')"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    # Набор можно удалить, обучение при этом остаётся: веса и метрики уже
    # посчитаны. Пока ключ был RESTRICT, удаление падало после того, как
    # папка уже снесена, — и набор висел «готовым» без файлов.
    set_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("train_sets.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    base_model: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    base_weights_path: Mapped[str | None] = mapped_column(sa.String(1024))
    task: Mapped[str] = mapped_column(TRAIN_TASK_ENUM, nullable=False)
    params: Mapped[dict] = mapped_column(JsonCol, nullable=False)
    device: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    status: Mapped[str] = mapped_column(
        TRAIN_RUN_STATUS_ENUM, nullable=False,
        default="queued", server_default="queued",
    )
    queue_reason: Mapped[str | None] = mapped_column(sa.String(200))
    epochs: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    current_epoch: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    phase: Mapped[str | None] = mapped_column(sa.String(8))
    current_batch: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    total_batches: Mapped[int | None] = mapped_column(sa.Integer)
    val_batch: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    val_total: Mapped[int | None] = mapped_column(sa.Integer)
    # Потери на лету. Перезаписывается по батчам, поэтому колонкой, а не
    # строкой в истории: истории по батчам никто не читает.
    batch_metrics: Mapped[dict | None] = mapped_column(JsonCol)
    summary: Mapped[dict | None] = mapped_column(JsonCol)
    # Матрица ошибок сырыми числами и точки кривых. Своими числами, а не
    # картинками ultralytics: два обучения обязаны ложиться на одну ось, а
    # картинкой этого не сделать.
    confusion: Mapped[dict | None] = mapped_column(JsonCol)
    curves: Mapped[dict | None] = mapped_column(JsonCol)
    # Метрики по классам: точность, полнота, F1 и обе mAP на каждый класс.
    # Отдельной колонкой, а не внутри `summary`: тот — плоский набор чисел
    # по всему набору, и складывать в него таблицу значило бы заставить
    # каждого читателя разбираться, что там лежит на этот раз.
    per_class: Mapped[dict | None] = mapped_column(JsonCol)
    best_epoch: Mapped[int | None] = mapped_column(sa.Integer)
    best_fitness: Mapped[float | None] = mapped_column(sa.Float)
    weights_path: Mapped[str | None] = mapped_column(sa.String(1024))
    weights_bytes: Mapped[int | None] = mapped_column(sa.BigInteger)
    gpu_lease_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("gpu_leases.id", ondelete="SET NULL")
    )
    peak_vram_mb: Mapped[int | None] = mapped_column(sa.Integer)
    lease_until: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    worker_id: Mapped[str | None] = mapped_column(sa.String(64))
    pid: Mapped[int | None] = mapped_column(sa.Integer)
    cancel_requested: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, default=False, server_default=sa.false()
    )
    error: Mapped[str | None] = mapped_column(sa.Text)
    started_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))


class TrainEpoch(Base):
    """Строка на эпоху.

    Строками, а не массивом внутри рана: график тянут во время обучения, и
    переписывать массив из трёхсот эпох на каждой эпохе — это квадрат записей.
    Вставка стоит одинаково всегда.

    ``metrics`` — как отдал ultralytics. Колонками это честно не описать:
    набор ключей разный у детекции и сегментации и меняется между версиями,
    так что схема начала бы врать на половине ранов.
    """

    __tablename__ = "train_epochs"

    run_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("train_runs.id", ondelete="CASCADE"), primary_key=True
    )
    epoch: Mapped[int] = mapped_column(sa.Integer, primary_key=True)
    metrics: Mapped[dict] = mapped_column(JsonCol, nullable=False)
    lr: Mapped[float | None] = mapped_column(sa.Float)
    # Сколько шла эпоха. «Осталось примерно» считается по факту, а не по
    # догадке: первая эпоха всегда медленнее остальных.
    seconds: Mapped[float | None] = mapped_column(sa.Float)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), nullable=False, default=utcnow
    )


# =========================================================================== #
# Проверка моделей на роликах
# =========================================================================== #
class CheckVideo(Base, AuditMixin):
    """Проверочный ролик проекта.

    Своя полка, а не ролики тасок: те удаляются вместе с закрытой таской, и
    сравнить две модели на одном ролике через месяц стало бы нечем.
    """

    __tablename__ = "check_videos"
    __table_args__ = (sa.Index("ix_check_videos_project", "project_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(sa.String(1024), nullable=False)
    thumb_path: Mapped[str | None] = mapped_column(sa.String(1024))
    duration_ms: Mapped[int | None] = mapped_column(sa.Integer)
    fps: Mapped[float | None] = mapped_column(sa.Float)
    width: Mapped[int | None] = mapped_column(sa.Integer)
    height: Mapped[int | None] = mapped_column(sa.Integer)
    frame_count: Mapped[int | None] = mapped_column(sa.Integer)
    size_bytes: Mapped[int] = mapped_column(
        sa.BigInteger, nullable=False, default=0, server_default="0"
    )


class ModelCheck(Base, AuditMixin):
    """Прогон обученной модели по ролику."""

    __tablename__ = "model_checks"
    __table_args__ = (
        sa.Index(
            "uq_check_active", "run_id", "video_id",
            unique=True,
            postgresql_where=sa.text(
                "status IN ('queued', 'waiting_gpu', 'running')"
            ),
        ),
        sa.Index("ix_model_checks_project", "project_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    run_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("train_runs.id", ondelete="CASCADE"), nullable=False
    )
    video_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("check_videos.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        CHECK_STATUS_ENUM, nullable=False, default="queued", server_default="queued"
    )
    params: Mapped[dict | None] = mapped_column(JsonCol)
    processed_frames: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
    total_frames: Mapped[int | None] = mapped_column(sa.Integer)
    output_path: Mapped[str | None] = mapped_column(sa.String(1024))
    output_bytes: Mapped[int | None] = mapped_column(sa.BigInteger)
    stats: Mapped[dict | None] = mapped_column(JsonCol)
    gpu_lease_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("gpu_leases.id", ondelete="SET NULL")
    )
    lease_until: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    worker_id: Mapped[str | None] = mapped_column(sa.String(64))
    pid: Mapped[int | None] = mapped_column(sa.Integer)
    cancel_requested: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, default=False, server_default=sa.false()
    )
    error: Mapped[str | None] = mapped_column(sa.Text)
    started_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
