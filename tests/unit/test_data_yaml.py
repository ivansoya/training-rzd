"""data.yaml не может стать кодом: имя проекта с переводом строки и белый список
ключей перед обучением (ключ download ultralytics исполняет как Python)."""
import os

import yaml

from common.storage import has_control, one_line
from training_svc import trainer


EVIL = "проект\ndownload: import os; os.system('id')\nval: /etc"


def test_управляющие_символы_находятся_и_вырезаются():
    assert has_control(EVIL) and has_control("a\rb") and has_control("a b")
    assert not has_control("Варан КЗТ · 2026")
    assert "\n" not in one_line(EVIL)


def test_белый_список_ключей_и_путь_набора(tmp_path):
    src_dir = tmp_path / "set"
    src_dir.mkdir()
    src = src_dir / "data.yaml"
    src.write_text(
        "train: images/train\nval: images/val\nnc: 2\nnames:\n  0: вагон\n  1: путь\n"
        "download: import os; os.system('id')\n",
        encoding="utf-8",
    )
    out = trainer.safe_data_yaml(str(src), str(tmp_path / "run"))
    data = yaml.safe_load(open(out, encoding="utf-8"))
    assert "download" not in data
    assert data["path"] == os.path.abspath(src_dir)
    assert data["train"] == "images/train" and data["names"] == {0: "вагон", 1: "путь"}


def test_имя_через_one_line_не_добавляет_ключей(tmp_path):
    # Комментарий с именем, как его пишут генераторы набора и экспорта.
    text = f"# проект «{one_line(EVIL)}»\ntrain: images/train\nval: images/val\n"
    assert set(yaml.safe_load(text)) == {"train", "val"}
