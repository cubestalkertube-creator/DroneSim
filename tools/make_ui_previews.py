"""UI preview images for the in-game menus (docs/previews -> assets/ui).

Maps: docs/previews/map_<id>.png -> assets/ui/maps/<id>.jpg (1280 px wide, JPEG q82).
Drones: docs/previews/ui/<id>.png (transparent) -> assets/ui/drones/<id>.webp (640 px, lossless alpha kept).
Run: python -I tools/make_ui_previews.py
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "previews"
OUT = ROOT / "assets" / "ui"


def main() -> int:
    (OUT / "maps").mkdir(parents=True, exist_ok=True)
    (OUT / "drones").mkdir(parents=True, exist_ok=True)
    for p in sorted(SRC.glob("map_*.png")):
        im = Image.open(p).convert("RGB")
        w = 1280
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        dst = OUT / "maps" / (p.stem[4:] + ".jpg")
        im.save(dst, quality=82, optimize=True, progressive=True)
        print(dst.relative_to(ROOT), dst.stat().st_size // 1024, "KB")
    for p in sorted((SRC / "ui").glob("*.png")):
        im = Image.open(p).convert("RGBA")
        im.thumbnail((640, 640), Image.LANCZOS)
        dst = OUT / "drones" / (p.stem + ".webp")
        im.save(dst, quality=88, method=6)
        print(dst.relative_to(ROOT), dst.stat().st_size // 1024, "KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
