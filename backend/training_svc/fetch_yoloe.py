"""Веса «Сети по тексту» в образ: YOLOE-26 четырёх размеров и кодировщик промтов.

Зовётся из Dockerfile, отдельным слоем до кода — решение владельца
(24.09.2026): веса едут в образе, во время работы ничего не качается. Питоном,
а не curl: ни curl, ни wget в образе нет. Длина сверяется с заголовком —
обрезанный файл уже дважды выдавал себя за целый (torch.hub, CDN Meta).
`mobileclip_blt` (600 МБ) не нужен: все YOLOE-26 берут `mobileclip2_b`.
"""
import os
import sys
import urllib.request

BASE = "https://github.com/ultralytics/assets/releases/download/v8.4.0/"
FILES = [f"yoloe-26{s}-seg.pt" for s in "smlx"] + ["mobileclip2_b.ts"]


def fetch(name, folder):
    path = os.path.join(folder, name)
    with urllib.request.urlopen(BASE + name, timeout=120) as r:
        want = int(r.headers["Content-Length"])
        with open(path + ".part", "wb") as out:
            while chunk := r.read(1 << 22):
                out.write(chunk)
    got = os.path.getsize(path + ".part")
    if got != want:
        sys.exit(f"{name}: пришло {got} байт из {want}")
    os.replace(path + ".part", path)
    print(name, want, flush=True)


if __name__ == "__main__":
    folder = sys.argv[1]
    os.makedirs(folder, exist_ok=True)
    for name in FILES:
        fetch(name, folder)
