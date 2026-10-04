"""Выгрузка делит заново теми же способами, что мастер набора."""
from test_project_data import imported, url  # noqa: F401 — фикстуры


def preview(api, project, mode, **extra):
    detail = api.get(url(project)).json()
    body = {
        "datasets": [d["id"] for d in detail["datasets"]],
        "classes": [c["id"] for c in api.get(url(project, "/classes")).json()["classes"]],
        "split_mode": mode, "val_ratio": 0.5, **extra,
    }
    res = api.post(url(project, "/export/preview"), json=body)
    assert res.status_code == 200, res.text
    return res.json()


def test_способы_деления(api, project, imported):
    for mode in ("keep", "random", "balanced"):
        p = preview(api, project, mode)
        assert p["split_mode"] == mode
        assert p["images"] == 2
        assert p["embeddings"] is None
    # Старое имя из прежнего окна — «с учётом классов»
    assert preview(api, project, "resplit")["split_mode"] == "balanced"
    # Неизвестное — как раньше, уважать проставленные половины
    assert preview(api, project, "чепуха")["split_mode"] == "keep"


def test_умное_без_признаков(api, project, imported):
    p = preview(api, project, "smart")
    assert p["split_mode"] == "smart"
    emb = p["embeddings"]
    assert emb["total"] == 2 and emb["missing"] == 2 and emb["ready"] == 0
    # Признаков нет — делится с учётом классов, и это сказано
    assert any("Признаки кадров ещё не посчитаны" in w for w in p["warnings"])
    assert p["images"] == 2
