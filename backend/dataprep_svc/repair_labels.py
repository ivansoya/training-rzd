"""Разовая починка наборов, собранных с меткой класса «6.0» (R-35).

    docker compose exec dataprep python -m dataprep_svc.repair_labels         # показать
    docker compose exec dataprep python -m dataprep_svc.repair_labels --yes   # починить

Переписывает строки меток в целые номера и пересчитывает в `report.json`
счёт по классам и предупреждения о покрытии: старые считались по нулям, а
«мало проверочных кадров» терялось у всех наборов (генератор обходился дважды).
"""
import argparse
import json
import os
import re
from collections import Counter, defaultdict

from sqlalchemy import select

from common import config
from common.db import SessionLocal
from common.models import TrainSet
from common.splitting import coverage_warnings

FLOAT_HEAD = re.compile(r"^(\d+)\.0+(?=\s)")


def _fix_labels(root, write):
    """Сколько файлов исправлено и счёт классов по сплитам после правки."""
    fixed = 0
    per_class = defaultdict(Counter)
    for split in ("train", "val"):
        folder = os.path.join(root, "labels", split)
        if not os.path.isdir(folder):
            continue
        for name in os.listdir(folder):
            path = os.path.join(folder, name)
            with open(path, encoding="utf-8") as fh:
                lines = fh.readlines()
            new = [FLOAT_HEAD.sub(r"\1", line) for line in lines]
            if new != lines:
                fixed += 1
                if write:
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.writelines(new)
            for line in new:
                head = line.split(maxsplit=1)
                if head and head[0].isdigit():
                    per_class[int(head[0])][split] += 1
                    per_class[int(head[0])]["annotations"] += 1
    return fixed, per_class


def _fix_report(path, per_class):
    with open(path, encoding="utf-8") as fh:
        report = json.load(fh)
    classes = report.get("classes") or []
    stale = set(coverage_warnings((c["name"], c["train"], c["val"]) for c in classes))
    for c in classes:
        got = per_class[c["export_id"]]
        c.update(train=got["train"], val=got["val"], annotations=got["annotations"])
    warnings = [w for w in report.get("warnings", []) if w not in stale]
    warnings.extend(coverage_warnings((c["name"], c["train"], c["val"]) for c in classes))
    report["warnings"] = warnings
    return report


def main():
    ap = argparse.ArgumentParser(description="Починить метки «6.0» в собранных наборах.")
    ap.add_argument("--yes", action="store_true", help="действительно переписать")
    args = ap.parse_args()

    with SessionLocal() as db:
        sets = db.execute(select(TrainSet).where(TrainSet.status == "ready")).scalars().all()
        touched = 0
        for tset in sets:
            root = config.trainset_dir(tset.project_id, tset.id)
            report_path = config.trainset_report(tset.project_id, tset.id)
            if not os.path.isfile(report_path):
                continue
            fixed, per_class = _fix_labels(root, args.yes)
            with open(report_path, encoding="utf-8") as fh:
                old = json.load(fh)
            report = _fix_report(report_path, per_class)
            if not fixed and report == old:
                continue
            touched += 1
            print(f"{tset.id}: файлов с «N.0» — {fixed}, "
                  f"предупреждений {len(old.get('warnings', []))} → {len(report['warnings'])}")
            if not args.yes:
                continue
            with open(report_path, "w", encoding="utf-8") as fh:
                json.dump(report, fh, ensure_ascii=False, indent=2)
            tset.counts = {**(tset.counts or {}), "warnings": len(report["warnings"])}
        if args.yes:
            db.commit()
    if not touched:
        print("Чинить нечего.")
    elif not args.yes:
        print("Запустите с --yes, чтобы переписать.")


if __name__ == "__main__":
    main()
