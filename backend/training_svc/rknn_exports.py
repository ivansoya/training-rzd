"""Exports live with their run on the shared volume and are removed with it."""
import os
import random
import re
import shutil
import tempfile
import time
import unicodedata
from pathlib import Path
from uuid import uuid4

import yaml
from flask import jsonify, request, send_file
from sqlalchemy import select

from common import config
from common.models import Image, LabelClass, Superclass, TrainSetSplit
from common.storage import load_json, save_json


def originals(db, run):
    paths = db.scalars(select(Image.file_path).join(TrainSetSplit, TrainSetSplit.image_id == Image.id).where(
        TrainSetSplit.set_id == run.set_id, TrainSetSplit.split == 'train', Image.project_id == run.project_id,
    ).order_by(Image.id))
    return [str(path) for rel in paths if (path := Path(config.DATA_DIR) / rel).is_file()]


def latest(root, owner):
    for folder in sorted(root.glob('job-*'), reverse=True):
        job = load_json(folder / 'status.json', None)
        if not job or job.get('owner') != owner:
            continue
        if job['state'] == 'running' and job.get('step') == 3 and job['variant'] == 'int8':
            fraction = calibration_progress(folder / 'convert.log')
            if fraction is not None:
                job['calibration_progress'] = fraction
        return job
    return None


def active_export(owner):
    for marker in Path(config.PROJECTS_DIR).glob('*/runs/*/rknn/job-*/pending'):
        job = load_json(marker.with_name('status.json'), None)
        if job and job.get('owner') == owner and job['state'] in ('queued', 'running'):
            return marker.parent, job
    return None, None


def calibration_progress(path):
    try:
        with path.open('rb') as log:
            log.seek(max(0, os.fstat(log.fileno()).st_size - 65536))
            tail = log.read(65536)
    except OSError:
        return None
    progress = None
    for match in re.finditer(rb'Quantizating\s+(\d+)/(\d+):[^\r\n]*?\|\s*(\d+)/(\d+)', tail):
        phase, phases, done, total = map(int, match.groups())
        if 1 <= phase <= phases and total > 0 and done <= total:
            progress = (phase - 1 + done / total) / phases
    return progress


def package_inputs(db, run, run_dir):
    palette = {}
    ambiguous = set()
    for cls, group in db.execute(select(LabelClass, Superclass).outerjoin(
        Superclass, (LabelClass.superclass_id == Superclass.id) & (Superclass.project_id == run.project_id),
    ).where(LabelClass.project_id == run.project_id)):
        name = unicodedata.normalize('NFC', cls.name)
        if name in palette:
            ambiguous.add(name)
        palette[name] = {'color': cls.color}
        if group:
            palette[name]['superclass'] = dict(key=f'sc_{group.id.hex}', name=group.name, color=group.color)
    for name in ambiguous:
        del palette[name]

    names = None
    snapshot = run_dir / 'data.yaml'
    if snapshot.is_file():
        data = yaml.safe_load(snapshot.read_text(encoding='utf-8'))
        if isinstance(data, dict):
            names = data.get('names')
    return dict(model_id=f'run-{run.id}', name=run.name, base_model=run.base_model, palette=palette, names=names)


def handle(db, run, user, artifact=None):
    root = Path(config.run_dir(run.project_id, run.id)) / 'rknn'
    owner = str(user.id)
    if artifact:
        folder = root / artifact
        status = load_json(folder / 'status.json', None) if re.fullmatch(r'job-[0-9]+-[0-9a-f]{32}', artifact) else None
        output = folder / ('model.rjdm' if status and status.get('format') == 'rjdm' else 'model.rknn')
        if not status or status.get('owner') != owner or status['state'] != 'done' or not output.is_file():
            return jsonify(error='Результат экспорта недоступен.'), 404
        return send_file(output, as_attachment=True, download_name=status['name'])
    if request.method == 'GET':
        result = {'job': latest(root, owner)}
        if request.args.get('frames') == '1':
            result['available'] = len(originals(db, run))
        return jsonify(result)

    body = request.get_json(silent=True)
    if not isinstance(body, dict) or set(body) - {'platform', 'variant', 'samples', 'format'}:
        return jsonify(error='Некорректные параметры экспорта.'), 400
    platform, variant = body.get('platform'), body.get('variant')
    output_format = body.get('format', 'rknn')
    if output_format not in ('rjdm', 'rknn'):
        return jsonify(error='Выберите формат RJDM или RKNN.'), 400
    if platform not in ('rk3566', 'rk3588') or variant not in ('fp', 'int8'):
        return jsonify(error='Выберите платформу Rockchip и точность.'), 400
    db.refresh(user, with_for_update=True)
    db.refresh(run, with_for_update=True)
    folder, current = active_export(owner)
    if current:
        samples = body.get('samples') if variant == 'int8' else 0
        if folder.parent == root and (current['platform'], current['variant'], current['samples'], current.get('format', 'rknn')) == (platform, variant, samples, output_format):
            return jsonify(job=current), 202
        return jsonify(error='У вас уже выполняется экспорт модели. Дождитесь его завершения.'), 409
    weights = Path(config.DATA_DIR) / (run.weights_path or '')
    if not weights.is_file() or weights.suffix.lower() not in ('.pt', '.onnx'):
        return jsonify(error='У обучения нет сохранённых весов для экспорта.'), 409
    frames = []
    if variant == 'int8':
        count = body.get('samples')
        available = originals(db, run)
        if type(count) is not int or not 1 <= count <= len(available):
            return jsonify(error=f'Для INT8 доступно исходных кадров train: {len(available)}.'), 400
        frames = random.Random(str(run.id)).sample(available, count)
    root.mkdir(exist_ok=True)
    jid = f'job-{time.time_ns()}-{uuid4().hex}'
    job = dict(id=jid, owner=owner, state='queued', stage='В очереди', platform=platform, variant=variant,
               format=output_format, samples=len(frames), name=f'run-{run.number}-{variant}-{platform}.{output_format}')
    inputs = dict(task=run.task, imgsz=run.params.get('imgsz', 640), frames=frames)
    if output_format == 'rjdm':
        try:
            inputs.update(package_inputs(db, run, root.parent))
        except (OSError, ValueError, yaml.YAMLError):
            return jsonify(error='Не удалось прочитать сохранённые классы обучения для RJDM.'), 409
    stage = Path(tempfile.mkdtemp(dir=root))
    try:
        shutil.copyfile(weights, stage / ('source' + weights.suffix.lower()))
        save_json(stage / 'input.json', inputs)
        save_json(stage / 'status.json', job)
        (stage / 'pending').touch()
        stage.rename(root / jid)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    return jsonify(job=job), 202
