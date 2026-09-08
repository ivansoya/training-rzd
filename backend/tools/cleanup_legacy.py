"""Уборка за старым приложением /tools. Запускается руками, а не при старте.

    docker compose exec datasets python -m tools.cleanup_legacy         # показать
    docker compose exec datasets python -m tools.cleanup_legacy --yes   # снести

Почему не при старте контейнера. Уборка при подъёме — это `rm -rf` по чужим
гигабайтам на КАЖДОМ запуске. Один неверный путь, и данные проекта уходят
молча, без следа и без вопроса. Скрипт печатает, что нашёл и сколько это
весит, требует явного согласия и на чистом томе честно отвечает, что делать
нечего.

`models/` и `models.json` не трогаем: полка своих моделей нужна новому
обучению, и заменить её нечем.
"""
import argparse
import os
import shutil
import sys

from common import config

# Что уходит вместе с приложением. Пути перечислены явно, а не собраны
# правилом: правило однажды подхватит лишнее.
LEGACY_DIRS = ("uploaded", "augmented", "trainings", "videos", "inference")
LEGACY_FILES = (
    "configs.json", "augmented.json", "datasets.json", "trainings.json",
)
KEEP = ("models", "models.json", "projects", "_jobs", "_tmp", "_autolabel",
        "_embed")


def size_of(path):
    if os.path.isfile(path):
        return os.path.getsize(path)
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def human(n):
    for unit in ("Б", "КБ", "МБ", "ГБ", "ТБ"):
        if n < 1024 or unit == "ТБ":
            return f"{n:.1f} {unit}".replace(".0 ", " ")
        n /= 1024
    return f"{n:.1f} ТБ"


def main():
    ap = argparse.ArgumentParser(
        description="Убрать данные приложения /tools с общего тома."
    )
    ap.add_argument("--yes", action="store_true", help="действительно удалить")
    args = ap.parse_args()

    found, total = [], 0
    for name in LEGACY_DIRS + LEGACY_FILES:
        path = os.path.join(config.DATA_DIR, name)
        if os.path.exists(path):
            weight = size_of(path)
            found.append((path, weight))
            total += weight

    if not found:
        print("Нечего убирать.")
        return 0

    print("Найдено от старого приложения:")
    for path, weight in found:
        print(f"  {path:60s} {human(weight):>10s}")
    print(f"  {'итого':60s} {human(total):>10s}")
    print()
    print("Останутся нетронутыми:", ", ".join(KEEP))

    if not args.yes:
        print()
        print("Это был показ. Чтобы удалить, повторите с --yes.")
        return 0

    for path, _weight in found:
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        else:
            try:
                os.remove(path)
            except OSError:
                pass
        print("убрано:", path)
    print(f"Освобождено: {human(total)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
