"""Convert one server-produced model, in its isolated job directory."""
import os
import sys
from pathlib import Path

import onnx
from rknn.api import RKNN

from common.storage import load_json, save_json
from rknn_svc import rjdm
from rknn_svc.onnx_head import describe, split_head


def convert(folder):
    job = load_json(folder / 'status.json', {})
    inputs = load_json(folder / 'input.json', {})

    def stage(number, text):
        job.update(state='running', stage=text, step=number)
        save_json(folder / 'status.json', job)

    quant = job['variant'] == 'int8'
    expected = {'detect': (1, 9), 'segment': (2, 13)}[inputs['task']][int(quant)]
    graph = folder / 'source.onnx'
    if (folder / 'source.pt').is_file():
        from ultralytics import YOLO
        stage(1, 'Подготовка ONNX из весов обучения')
        model = YOLO(str(folder / 'source.pt'))
        if model.task != inputs['task']:
            raise ValueError(f'Тип модели {model.task} отличается от задачи обучения {inputs["task"]}.')
        graph = Path(model.export(format='onnx', imgsz=inputs['imgsz'], device='cpu', opset=12,
                                  simplify=True, dynamic=False, end2end=False))
    stage(2, 'Проверка графа ONNX')
    onnx.checker.check_model(str(graph))
    calibration = None
    if quant:
        if not inputs['frames'] or any(not Path(p).is_file() for p in inputs['frames']):
            raise ValueError('Часть исходных кадров train недоступна. Подготовьте выборку заново.')
        calibration = folder / 'calibration.txt'
        calibration.write_text('\n'.join(inputs['frames']) + '\n', encoding='utf-8')
        target = folder / 'split.onnx'
        outputs = split_head(str(graph), str(target))
        graph = target
    else:
        outputs = describe(str(graph))
    if len(outputs) != expected:
        raise ValueError(f'Несовместимая голова {inputs["task"]}: ожидалось выходов {expected}, получено {len(outputs)}.')
    package = rjdm.manifest(onnx.load(str(graph)), inputs, job) if job.get('format') == 'rjdm' else None
    toolkit = RKNN(verbose=False)
    def check(operation, code):
        if code != 0:
            raise RuntimeError(f'{operation}: RKNN Toolkit вернул {code}')
    try:
        config = dict(target_platform=job['platform'], mean_values=[[0, 0, 0]], std_values=[[255, 255, 255]])
        if quant:
            config.update(quantized_dtype='w8a8', quantized_algorithm='normal', quant_img_RGB2BGR=False)
        check('config', toolkit.config(**config))
        check('load_onnx', toolkit.load_onnx(model=str(graph)))
        stage(3, 'Калибровка и сборка RKNN' if quant else 'Сборка RKNN')
        check('build', toolkit.build(do_quantization=quant, dataset=str(calibration) if quant else None))
        stage(4, 'Запись модели')
        tmp = folder / 'building.rknn'
        check('export_rknn', toolkit.export_rknn(str(tmp)))
        if tmp.stat().st_size == 0:
            raise RuntimeError('Конвертер создал пустой файл.')
        if package is None:
            os.replace(tmp, folder / 'model.rknn')
        else:
            archive = folder / 'building.rjdm'
            rjdm.pack(tmp, archive, package)
            os.replace(archive, folder / 'model.rjdm')
    finally:
        toolkit.release()


if __name__ == '__main__':
    convert(Path(sys.argv[1]).resolve())
