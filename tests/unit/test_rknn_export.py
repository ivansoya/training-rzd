import hashlib
import json
import uuid
import zipfile
from types import SimpleNamespace

from flask import Flask
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from rknn_svc import rjdm
from training_svc import rknn_exports as exports


def test_only_available_training_originals(tmp_path, monkeypatch):
    monkeypatch.setattr(exports.config, 'DATA_DIR', str(tmp_path))
    run = SimpleNamespace(project_id=uuid.uuid4(), set_id=uuid.uuid4())
    with Session(create_engine('sqlite://')) as db:
        db.execute(text('CREATE TABLE images (id TEXT, project_id TEXT, file_path TEXT)'))
        db.execute(text('CREATE TABLE train_set_splits (set_id TEXT, image_id TEXT, split TEXT)'))
        for name, split in [('real', 'train'), ('validation', 'val'), ('missing', 'train'), ('augmented', None)]:
            iid = uuid.uuid4().hex
            db.execute(text('INSERT INTO images VALUES (:i, :p, :f)'), dict(i=iid, p=run.project_id.hex, f=name))
            if split:
                db.execute(text('INSERT INTO train_set_splits VALUES (:s, :i, :v)'), dict(s=run.set_id.hex, i=iid, v=split))
            if name != 'missing':
                (tmp_path / name).touch()
        assert exports.originals(db, run) == [str(tmp_path / 'real')]


def test_queue_duplicate_input_and_download(tmp_path, monkeypatch):
    monkeypatch.setattr(exports.config, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(exports.config, 'PROJECTS_DIR', str(tmp_path))
    run_dir = lambda project, run: tmp_path / str(project) / 'runs' / str(run)
    monkeypatch.setattr(exports.config, 'run_dir', run_dir)
    run = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4(), set_id=None, weights_path='best.pt', number=42, task='detect', params={})
    other_run = SimpleNamespace(**{**vars(run), 'id': uuid.uuid4()})
    home = run_dir(run.project_id, run.id)
    home.mkdir(parents=True)
    (tmp_path / 'best.pt').write_bytes(b'weights from run')
    db = SimpleNamespace(refresh=lambda *a, **kw: None, scalars=lambda _: [])
    user, other = (SimpleNamespace(id=uuid.uuid4()) for _ in range(2))
    app = Flask(__name__)
    app.add_url_rule('/export', 'export', lambda: exports.handle(db, run, user), methods=['GET', 'POST'])
    app.add_url_rule('/other', 'other', lambda: exports.handle(db, run, other), methods=['GET', 'POST'])
    app.add_url_rule('/other-run', 'other_run', lambda: exports.handle(db, other_run, user), methods=['POST'])
    app.add_url_rule('/download/<artifact>', 'download', lambda artifact: exports.handle(db, run, user, artifact))
    app.add_url_rule('/other-download/<artifact>', 'other_download', lambda artifact: exports.handle(db, run, other, artifact))
    client = app.test_client()
    params = dict(platform='rk3588', variant='fp')
    assert client.post('/export', json={**params, 'file': 'external.pt'}).status_code == 400
    assert client.post('/export', json={**params, 'variant': 'int8', 'samples': 1}).status_code == 400
    job = client.post('/export', json=params).json['job']
    assert client.post('/export', json=params).json['job'] == job
    assert client.get('/export').json['job'] == job
    assert client.get('/other').json['job'] is None
    assert client.post('/other-run', json=params).status_code == 409
    other_job = client.post('/other', json=params).json['job']
    assert other_job['id'] != job['id'] and client.get('/export').json['job'] == job
    folder = home / 'rknn' / job['id']
    (folder / 'status.json').write_text(json.dumps({**job, 'state': 'running', 'step': 3, 'variant': 'int8'}))
    (folder / 'convert.log').write_bytes(b'I Quantizating 1/13: 100%|bar| 50/50\rI Quantizating 2/13: 50%|bar| 25/50\r')
    assert client.get('/export').json['job']['calibration_progress'] == 1.5 / 13
    assert (folder / 'source.pt').read_bytes() == b'weights from run'
    assert client.get('/download/' + job['id']).status_code == 404
    (folder / 'model.rknn').write_bytes(b'result')
    (folder / 'status.json').write_text(json.dumps({**job, 'state':'done'}))
    assert client.get('/other-download/' + job['id']).status_code == 404
    response = client.get('/download/' + job['id'])
    assert response.data == b'result' and job['name'] in response.headers['Content-Disposition']
    response.close()

    run.name = 'Станция «Ёлки»'
    run.base_model = 'yolo11n'
    db.execute = lambda _: []
    (home / 'data.yaml').write_text('names: {0: "Ёлка"}', encoding='utf-8')
    assert client.post('/export', json={**params, 'format': 'zip'}).status_code == 400
    package = client.post('/export', json={**params, 'format': 'rjdm'}).json['job']
    assert package['name'].endswith('.rjdm')
    assert client.post('/export', json=params).status_code == 409
    assert client.post('/export', json={**params, 'format': 'rjdm'}).json['job'] == package
    folder = home / 'rknn' / package['id']
    inputs = json.loads((folder / 'input.json').read_text(encoding='utf-8'))
    assert inputs['name'] == run.name and inputs['names'] == {'0': 'Ёлка'}
    (folder / 'model.rjdm').write_bytes(b'archive')
    (folder / 'status.json').write_text(json.dumps({**package, 'state': 'done'}))
    response = client.get('/download/' + package['id'])
    assert response.data == b'archive' and package['name'] in response.headers['Content-Disposition']
    response.close()


def test_rjdm_stores_manifest_and_weights_without_zip64(tmp_path):
    weights = tmp_path / 'model.rknn'
    weights.write_bytes(b'RKNN example')
    target = tmp_path / 'model.rjdm'
    palette = {'Ёлка': {'superclass': {'key': 'plants', 'name': 'Растения', 'color': '#00AB23'}}}
    classes, groups = rjdm.labels({}, {'1': 'Человек в «жилете»', '0': 'Е\u0308лка'}, palette, 2)
    rjdm.pack(weights, target, dict(format='rjdm', schema_version=1, classes=classes, superclasses=groups, weights={}))

    with zipfile.ZipFile(target) as archive:
        assert archive.namelist() == ['manifest.json', 'weights.rknn']
        assert all(entry.compress_type == zipfile.ZIP_STORED and not entry.extra and not entry.flag_bits & 1
                   for entry in archive.infolist())
        encoded = archive.read('manifest.json')
        assert 'Ёлка'.encode() in encoded and not encoded.startswith(b'\xef\xbb\xbf')
        data = json.loads(encoded)
        assert data['classes'] == [dict(id=0, name='Ёлка', superclass='plants'), dict(id=1, name='Человек в «жилете»')]
        assert data['superclasses'] == [dict(key='plants', name='Растения', color='#00AB23')]
        payload = archive.read('weights.rknn')
        assert payload == weights.read_bytes()
        assert data['weights']['size'] == len(payload)
        assert data['weights']['sha256'] == hashlib.sha256(payload).hexdigest()
