"""Shared storage layout. Every service mounts the same ``yolo-data`` volume at
/app/data, so all paths are defined here once.
"""
import os

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")

# Path used to report *real host* disk usage in the sidebar meter. Inside the
# container, ``shutil.disk_usage(DATA_DIR)`` measures the Docker/WSL2 virtual
# disk (a sparse vhdx that advertises ~1 TB), not the physical drive. The
# compose file bind-mounts a host directory here so we can stat the actual
# drive Docker stores its data on. Falls back to DATA_DIR when unset.
HOST_STAT_PATH = os.environ.get("HOST_STAT_PATH")

# Свои модели: .pt и .yaml, которые человек принёс сам. Единственное, что
# пережило удаление старого приложения на /tools, — заменить их нечем, а
# обучению они нужны как основа.
MODELS_DIR = os.path.join(DATA_DIR, "models")
MODELS_FILE = os.path.join(DATA_DIR, "models.json")

# Data of the new site's projects. Binaries only — everything queryable about
# them (classes, splits, annotations) lives in PostgreSQL. Images are named by
# their row id, so archive folder structure never has to be reproduced here.
PROJECTS_DIR = os.path.join(DATA_DIR, "projects")
THUMB_MAX_SIDE = 320
THUMB_QUALITY = 80
# Промежуточный размер для режима просмотра: оригинал в 670 КБ там не нужен,
# а превью в 320 px мало. Делается лениво при первом запросе и кэшируется,
# поэтому уже импортированные датасеты перегонять не требуется.
PREVIEW_MAX_SIDE = 1280
PREVIEW_QUALITY = 82

# Transient job state lives on the shared volume too: it is a fast named volume
# (ext4), so atomic renames are reliably visible across service containers — the
# datasets service can serve a job created by the augmentation service.
JOBS_DIR = os.path.join(DATA_DIR, "_jobs")
TMP_DIR = os.path.join(DATA_DIR, "_tmp")

# Готовые выгрузки проектов. Живут рядом с временным, но своей папкой: их
# чистит возраст, а не завершение операции — ссылку на скачивание человек
# открывает уже после того, как джоба закончилась.
EXPORTS_DIR = os.path.join(TMP_DIR, "exports")
EXPORT_KEEP_HOURS = 6


def export_file(job_id):
    return os.path.join(EXPORTS_DIR, f"{job_id}.zip")


def export_meta(job_id):
    """Паспорт выгрузки рядом с архивом: скачивание не зависит от того, жива
    ли ещё запись джобы (файлы джоб чистятся по возрасту)."""
    return os.path.join(EXPORTS_DIR, f"{job_id}.json")

# Веса моделей полуавтоматической разметки. На томе, а не в образе: образ не
# пухнет на гигабайты, веса переживают пересборку, а сменить размер модели
# можно переменной окружения. Отдельно от MODELS_DIR — тот перечисляется как
# список обученных моделей в /tools, и папка sam2 в нём стала бы «моделью».
AUTOLABEL_DIR = os.path.join(DATA_DIR, "_autolabel")


def auto_weights_dir(model):
    return os.path.join(AUTOLABEL_DIR, model)

# Веса сети, которая считает признаки кадров для умного деления. Тем же
# способом, что и веса полуавтомата: на томе, а не в образе.
EMBED_DIR = os.path.join(DATA_DIR, "_embed")

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}

_ALL_DIRS = (
    MODELS_DIR, JOBS_DIR, TMP_DIR, EXPORTS_DIR, PROJECTS_DIR, AUTOLABEL_DIR,
    EMBED_DIR,
)


def project_dir(project_id):
    return os.path.join(PROJECTS_DIR, str(project_id))


def project_images_dir(project_id):
    return os.path.join(project_dir(project_id), "images")


# Обучающие наборы, обучения и проверки лежат внутри проекта, а не общей
# кучей: удаление проекта тогда уносит их одним движением, а место, занятое
# проектом, считается одним обходом каталога.
def project_trainsets_dir(project_id):
    return os.path.join(project_dir(project_id), "trainsets")


def trainset_dir(project_id, set_id):
    return os.path.join(project_trainsets_dir(project_id), str(set_id))


def trainset_manifest(project_id, set_id):
    """Построчный список образцов набора.

    Файлом, а не строками в базе: набор из ста тысяч кадров при графе ×6 —
    это шестьсот тысяч строк, которые ни с чем не соединяются и живут ровно
    столько же, сколько папка рядом.
    """
    return os.path.join(trainset_dir(project_id, set_id), "manifest.jsonl")


def trainset_report(project_id, set_id):
    return os.path.join(trainset_dir(project_id, set_id), "report.json")


def project_runs_dir(project_id):
    return os.path.join(project_dir(project_id), "runs")


def run_dir(project_id, run_id):
    return os.path.join(project_runs_dir(project_id), str(run_id))


def check_videos_dir(project_id):
    return os.path.join(project_dir(project_id), "checkvideos")


def check_video_file(project_id, video_id, ext=".mp4"):
    return os.path.join(check_videos_dir(project_id), f"{video_id}{ext}")


def project_checks_dir(project_id):
    return os.path.join(project_dir(project_id), "checks")


def check_dir(project_id, check_id):
    return os.path.join(project_checks_dir(project_id), str(check_id))


def project_thumbs_dir(project_id):
    return os.path.join(project_dir(project_id), "thumbs")


def project_preview_dir(project_id):
    return os.path.join(project_dir(project_id), "preview")


def project_import_file(project_id):
    """State of the import wizard: survives a closed tab and a restart."""
    return os.path.join(project_dir(project_id), "_import.json")


# Файлы таски лежат своим путём и НЕ переезжают при принятии кадров в проект:
# перенос гигабайтов ради смены принадлежности того не стоит, а `task_id` у
# кадра всё равно остаётся навсегда и однозначно указывает, где искать.
def task_dir(project_id, task_id):
    return os.path.join(project_dir(project_id), "tasks", str(task_id))


def task_video_dir(project_id, task_id):
    return os.path.join(task_dir(project_id, task_id), "video")


def task_video_frames_dir(project_id, task_id, video_id):
    """Распакованные кадры ролика.

    Кладёт их datasets_svc, а читает ещё и autolabel_svc: путь строился в двух
    местах по отдельности, и разойтись им было нечем помешать.
    """
    return os.path.join(task_video_dir(project_id, task_id), f"{video_id}_frames")


def task_video_frame_file(project_id, task_id, video_id, frame_no,
                          width=None, height=None):
    """Файл распакованного кадра. Размер в имени — не украшение.

    Кадр кэшируется в разрешении источника: по нему работает полуавтомат, и
    координаты клика приходят в тех же пикселях. Прежде сюда клали кадр из
    ближайшего готового перегона, то есть ступени качества, — под тем же
    именем, и отличить одно от другого было нельзя. Размер в имени их разводит:
    файлы прежней схемы просто не находятся и уходят с уборкой кэша.
    """
    folder = task_video_frames_dir(project_id, task_id, video_id)
    size = f"@{int(width)}x{int(height)}" if width and height else ""
    return os.path.join(folder, f"{int(frame_no)}{size}.jpg")


def image_base_dir(project_id, task_id=None):
    """Корень, под которым лежат images/, thumbs/ и preview/ этого кадра."""
    return (
        task_dir(project_id, task_id) if task_id else project_dir(project_id)
    )


def ensure_dirs():
    for d in _ALL_DIRS:
        os.makedirs(d, exist_ok=True)
