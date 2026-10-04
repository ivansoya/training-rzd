"""Экран «Классы»: кадры и сплиты по классу считаются только по кадрам датасетов.

Боксы класса — его цена во всём проекте, вместе с черновиками тасок; а «Кадров»
и «Доля в val» — про данные, которые уйдут в обучение.
"""
from test_project_data import draft, imported, url  # noqa: F401 — фикстуры


def classes(api, project, **params):
    res = api.get(url(project, "/classes"), params=params or None)
    assert res.status_code == 200, res.text
    return {c["name"]: c for c in res.json()["classes"]}


def test_пустой_класс(api, project, label_class):
    c = classes(api, project)[label_class["name"]]
    assert c["images"] == 0
    assert c["split"] == {"train": 0, "val": 0, "other": 0}


def test_кадры_и_сплиты_без_черновиков(api, project, imported, draft):
    got = classes(api, project)
    # Черновик таски несёт рамку «вагона»: в цене класса она есть, в кадрах и сплитах — нет
    assert got["вагон"]["annotations"] == 2
    assert got["вагон"]["images"] == 1
    assert got["вагон"]["split"] == {"train": 1, "val": 0, "other": 0}
    assert got["опора"]["images"] == 1
    assert got["опора"]["split"] == {"train": 0, "val": 1, "other": 0}


def test_отбор_по_датасету_не_несёт_сплитов(api, project, imported):
    got = classes(api, project, dataset=imported)
    assert "split" not in got["вагон"] and "images" not in got["вагон"]
