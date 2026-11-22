"""Build a version 1 RJDM package from the exact graph passed to RKNN Toolkit."""
import ast
import hashlib
import json
import re
import unicodedata
import zipfile
from datetime import datetime, timezone
from importlib.metadata import version


def text(value, field):
    if not isinstance(value, str):
        raise ValueError(f'RJDM: {field} должно быть строкой.')
    value = unicodedata.normalize('NFC', value)
    if not value.strip() or len(value) > 120 or any(unicodedata.category(c) == 'Cc' for c in value):
        raise ValueError(f'RJDM: {field} должно содержать от 1 до 120 символов без управляющих знаков.')
    return value


def model_info(graph, task):
    def shape(tensor, rank):
        dims = [d.dim_value for d in tensor.type.tensor_type.shape.dim]
        if len(dims) != rank or dims[0] != 1 or min(dims) <= 0:
            raise ValueError(f'RJDM: несовместимая форма {tensor.name}: {dims}.')
        return dims

    if len(graph.input) != 1 or task not in ('detect', 'segment'):
        raise ValueError('RJDM: требуется одна статическая модель detect или segment.')
    _, channels, height, width = shape(graph.input[0], 4)
    if channels != 3:
        raise ValueError('RJDM: модель должна принимать три цветовых канала.')
    outputs = list(graph.output)
    segment = task == 'segment'
    if len(outputs) == (2 if segment else 1):
        layout = 'single_seg' if segment else 'single'
        _, features, _ = shape(outputs[0], 3)
        masks = shape(outputs[1], 4)[1] if segment else 0
        classes = features - 4 - masks
    elif len(outputs) == (13 if segment else 9):
        layout = 'split_levels_seg' if segment else 'split_levels'
        stride = 4 if segment else 3
        masks = shape(outputs[-1], 4)[1] if segment else 0
        class_counts = set()
        for level in range(3):
            offset = level * stride
            box, scores, total = [shape(t, 4) for t in outputs[offset:offset + 3]]
            if box[1] not in (4, 64) or box[2:] != scores[2:] or total[1:] != [1, *scores[2:]]:
                raise ValueError('RJDM: формы боксов и скоров уровня не совпадают.')
            if segment and shape(outputs[offset + 3], 4)[1:] != [masks, *scores[2:]]:
                raise ValueError('RJDM: формы коэффициентов и прототипа масок не совпадают.')
            class_counts.add(scores[1])
        if len(class_counts) != 1:
            raise ValueError('RJDM: разные количества классов на уровнях модели.')
        classes = class_counts.pop()
    else:
        raise ValueError('RJDM: модель имеет неподдерживаемую раскладку выходов.')
    if classes <= 0:
        raise ValueError('RJDM: в тензорах модели нет классов.')
    return dict(task=task, input_width=width, input_height=height, input_channels=channels,
                output_layout=layout, class_count=classes)


def labels(metadata, fallback, palette, class_count):
    raw = metadata.get('names')
    try:
        names = ast.literal_eval(raw) if raw is not None else fallback
    except (SyntaxError, ValueError) as exc:
        raise ValueError('RJDM: не удалось прочитать имена классов из ONNX.') from exc
    if isinstance(names, dict) and all(type(i) in (str, int) for i in names):
        by_index = {str(i): name for i, name in names.items()}
        order = [str(i) for i in range(class_count)]
        if len(names) == class_count and by_index.keys() == set(order):
            names = [by_index[i] for i in order]
    if not isinstance(names, list) or len(names) != class_count:
        raise ValueError(f'RJDM: нужны имена для всех {class_count} классов модели в порядке выходов.')
    classes, superclasses, seen = [], {}, set()
    for i, name in enumerate(names):
        name = text(name, f'имя класса {i}')
        if name.strip() in seen:
            raise ValueError(f'RJDM: повторяется имя класса «{name}».')
        seen.add(name.strip())
        row = dict(id=i, name=name)
        style = palette.get(name, {})
        if 'color' in style:
            row['color'] = color(style['color'])
        if group := style.get('superclass'):
            key = group['key']
            if not re.fullmatch(r'[a-z0-9_]+', key):
                raise ValueError('RJDM: неверный ключ суперкласса.')
            row['superclass'] = key
            superclasses[key] = dict(key=key, name=text(group['name'], 'имя суперкласса'), color=color(group['color']))
        classes.append(row)
    return classes, list(superclasses.values())


def color(value):
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9A-Fa-f]{6}', value):
        raise ValueError(f'RJDM: недопустимый цвет {value!r}, ожидается #RRGGBB.')
    return value


def manifest(model, inputs, job):
    info = model_info(model.graph, inputs['task'])
    metadata = {m.key: m.value for m in model.metadata_props}
    classes, superclasses = labels(metadata, inputs.get('names'), inputs['palette'], info['class_count'])
    if family := re.match(r'yolo(?:v)?\d+', inputs['base_model'].lower()):
        info['family'] = family.group()
    model_id = inputs['model_id']
    if not re.fullmatch(r'[a-z0-9_-]{1,64}', model_id):
        raise ValueError('RJDM: неверный идентификатор модели.')
    return dict(format='rjdm', schema_version=1, id=model_id, name=text(inputs['name'], 'имя модели'),
                model=info, classes=classes, superclasses=superclasses,
                weights=dict(file='weights.rknn', target_platform=job['platform'],
                             toolkit_version=version('rknn-toolkit2'), quantized=job['variant'] == 'int8'))


def pack(weights, target, data):
    with weights.open('rb') as source:
        size = weights.stat().st_size
        if not size:
            raise ValueError('RJDM: файл весов пуст.')
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
        data['weights'].update(size=size, sha256=digest)
        data['created_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        payload = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False).encode('utf-8')
        source.seek(0)
        info = zipfile.ZipInfo('weights.rknn')
        info.file_size = size
        archived = hashlib.sha256()
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
            archive.writestr('manifest.json', payload)
            with archive.open(info, 'w') as member:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    archived.update(chunk)
                    member.write(chunk)
        if archived.hexdigest() != digest:
            raise ValueError('RJDM: веса изменились за время упаковки.')
