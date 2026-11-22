import fcntl
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

from common import config
from common.storage import load_json, save_json


def process(marker):
    folder = marker.parent
    with marker.open('rb') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        status = folder / 'status.json'
        job = load_json(status, {})
        if job.get('state') in ('queued', 'running'):
            log_path = folder / 'convert.log'
            with log_path.open('wb') as log:
                result = subprocess.run([sys.executable, '-m', 'rknn_svc.convert', str(folder)],
                                        cwd=folder, stdout=log, stderr=subprocess.STDOUT)
            job = load_json(status, job)
            output = 'model.rjdm' if job.get('format') == 'rjdm' else 'model.rknn'
            if result.returncode or not (folder / output).is_file():
                with log_path.open('rb') as log:
                    log.seek(max(0, os.fstat(log.fileno()).st_size - 6000))
                    detail = log.read().decode('utf-8', errors='replace').strip()
                failure = f'Конвертер завершился с кодом {result.returncode}.' if result.returncode else 'Файл экспорта не создан.'
                job.update(state='error', error=f'{failure}\n{detail}'.strip())
            else:
                job.update(state='done', stage='Модель готова')
            save_json(status, job)
        for name in ('source.pt', 'source.onnx', 'split.onnx', 'calibration.txt', 'building.rknn', 'building.rjdm', 'input.json'):
            (folder / name).unlink(missing_ok=True)
        marker.unlink(missing_ok=True)


def main():
    while True:
        for marker in sorted(Path(config.PROJECTS_DIR).glob('*/runs/*/rknn/job-*/pending')):
            try:
                process(marker)
            except FileNotFoundError:
                continue  # Обучение удалили или задание уже завершил другой воркер.
            except Exception:
                traceback.print_exc()
        time.sleep(2)


if __name__ == '__main__':
    main()
