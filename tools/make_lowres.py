"""Mobile texture set: writes <name>_1k.jpg next to every <name>_2k.jpg in assets/textures and assets/props.

Usage:  python -I tools/make_lowres.py [--force]
The mobile build (`npm run build:mobile`, `npm run android:apk`) ships only the 1k files; the runtime swaps prop glTF URIs to them.
Skips files whose 1k version is already newer than the 2k source (unless --force).
Texture sets without an ARM map (AO/rough/metal packed, what the runtime loads) get one built from *_rough_2k.jpg
(AO = 1, metal = 0).
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "assets"
FORCE = "--force" in sys.argv


def pack_missing_arm() -> int:
    n = 0
    for rough in (ROOT / "textures").rglob("*_rough_2k.jpg"):
        arm = rough.with_name(rough.name.replace("_rough_2k", "_arm_2k"))
        if arm.exists():
            continue
        with Image.open(rough) as im:
            r = im.convert("L")
            one = Image.new("L", r.size, 255)
            zero = Image.new("L", r.size, 0)
            Image.merge("RGB", (one, r, zero)).save(arm, "JPEG", quality=92, optimize=True)
        n += 1
    return n


def main() -> None:
    print(f"ARM maps packed: {pack_missing_arm()}")
    done = skipped = 0
    for folder in (ROOT / "textures", ROOT / "props"):
        for src in folder.rglob("*_2k.jpg"):
            dst = src.with_name(src.name[: -len("_2k.jpg")] + "_1k.jpg")
            if not FORCE and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
                skipped += 1
                continue
            with Image.open(src) as im:
                w, h = im.size
                im = im.convert("RGB").resize((max(1, w // 2), max(1, h // 2)), Image.LANCZOS)
                im.save(dst, "JPEG", quality=88, optimize=True)
            done += 1
    print(f"1k textures: {done} written, {skipped} up to date")


if __name__ == "__main__":
    main()
