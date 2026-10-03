"""Общий разбор ввода и JSON-ошибки: мусор в теле — 400 с текстом, а не HTML 500."""
import pytest

flask = pytest.importorskip("flask")

from common.web import (  # noqa: E402
    InputError, color_field, int_field, json_body, register_json_errors, str_field,
)


@pytest.fixture
def client():
    app = flask.Flask(__name__)
    register_json_errors(app)

    @app.post("/echo")
    def echo():
        data = json_body()
        return {"name": str_field(data, "name", max_len=5), "n": int_field(data, "n", lo=0)}

    @app.get("/boom")
    def boom():
        raise RuntimeError("секрет /app/data")

    return app.test_client()


def test_список_вместо_объекта_и_nan_дают_400(client):
    assert client.post("/echo", data="[1]", content_type="application/json").status_code == 400
    res = client.post("/echo", data='{"n": NaN}', content_type="application/json")
    assert res.status_code == 400 and res.json["error"]


def test_поле_длиннее_предела_называет_поле(client):
    res = client.post("/echo", json={"name": "abcdef"})
    assert res.status_code == 400 and "name" in res.json["errors"]


def test_пустое_тело_это_пустой_объект(client):
    assert client.post("/echo").json == {"name": "", "n": None}


def test_падение_не_выдаёт_подробностей(client):
    res = client.get("/boom")
    assert res.status_code == 500 and "/app/data" not in res.get_data(as_text=True)


def test_404_тоже_json(client):
    assert client.get("/nope").json["error"]


def test_помощники():
    assert int_field({"n": "12"}, "n") == 12
    with pytest.raises(InputError):
        int_field({"n": "abc"}, "n")
    with pytest.raises(InputError):
        int_field({"n": True}, "n")
    assert color_field({"c": "#AABBCC"}, "c") == "#aabbcc"
    with pytest.raises(InputError):
        color_field({"c": "red"}, "c")
