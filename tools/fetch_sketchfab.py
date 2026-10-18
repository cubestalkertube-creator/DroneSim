"""Download the curated Sketchfab models (CC-BY etc.) - requires YOUR free Sketchfab API token.

1. Sign in at https://sketchfab.com  ->  Settings -> Password & API -> copy "API token".
2. PowerShell:   $env:SKETCHFAB_TOKEN="xxxxxxxx"; python -I tools/fetch_sketchfab.py [--only drones|maps|props] [--all]
   bash:         SKETCHFAB_TOKEN=xxxxxxxx python -I tools/fetch_sketchfab.py

Files go to assets/_sketchfab/<group>/<slug>/ (glTF zip unpacked) and assets/_sketchfab/CREDITS.json.
CC-BY models REQUIRE attribution in the game's Credits screen (the game reads CREDITS.json).
Models marked nc=True are Non-Commercial (and nd = No-Derivatives): skipped unless --all; OK for a private prototype only.
"""
import io, json, os, re, sys, time, urllib.request, zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "assets", "_sketchfab")

# (group, uid, slug, note, nc)
MODELS = [
    # ---- drones (real-world look, used as hero/skins; physics params come from docs/research/DRONES.md)
    ("drones", "d471ea8c6235457b8e131842e2cf3783", "dji_fpv_sdc", "DJI FPV, 430k faces -> decimate", False),
    ("drones", "7c5346e50ffb4e8c9ac12cb0847be39a", "dji_fpv_polyman", "DJI FPV, 113k faces", False),
    ("drones", "c75dea6e3ae441ac87f292efb17f5bae", "fpv_7in_nonstop", "7-10in combat-style FPV, 25k faces", False),
    ("drones", "59b2d7a1f02a46e68ea72fdd66b05c09", "fpv_at4", "FPV with payload tube, 16k", False),
    ("drones", "0294037f390a4351926c11caf3e5c43e", "fpv_drone_jeyhun", "5in FPV, 59k", False),
    ("drones", "370fa7dd443c409789c9b0a2794a61ac", "racing_drone_lite", "racing quad low-poly 4k", False),
    ("drones", "e27ed758e2174a89a48368e84027f8d9", "dji_avata2", "cinewhoop class, 200k", False),
    ("drones", "158e4fa0710f4511be14b73374b5df9b", "dji_inspire3", "heavy cine drone, 515k", False),
    ("drones", "8e5b6972f7d049f19688096e03949487", "bayraktar_tb2", "MALE fixed-wing UAV 9k", False),
    ("drones", "3ae0e923b50f4885a2317eba199043cd", "morok_uav", "fixed-wing UAV 18k", False),
    ("drones", "50997d0d73a642d98d62a10cc7e6d50b", "metis_interceptor", "interceptor UAV 39k", False),
    ("drones", "8fe0b8ca71e8404d8ba3a0c65c64315b", "orion_e_uav", "fixed-wing recon UAV", False),
    ("drones", "267002a6ba5a4de58ade971cf84538dc", "zala_421", "fixed-wing recon UAV", False),
    ("drones", "bfc7a02b26814f51a265e57fcf2babc6", "shahed136_hwerke", "delta wing LM, CC BY-NC-ND", True),
    ("drones", "8f12f601efe44a73b47e30a7077cf249", "geran2_karosio", "delta wing LM, CC BY-NC-SA", True),
    # ---- pilot gear for menus / hangar
    ("props", "b604ff776f9a44ce89e2e2a3c2eae9a5", "rc_controller", "RC transmitter 47k", False),
    ("props", "0edc6bca739d4aa6952bb6b8747318bb", "radiomaster_tx12", "RC transmitter 40k", False),
    ("props", "44820e8eeaf54c7ea51f4fe0f57d86e9", "radiomaster_pocket", "RC transmitter 38k", False),
    ("props", "56197e46626341acb8b7924494f9e8c9", "fpv_goggles", "goggles 40k", False),
    ("props", "92481579ccaa46d6b5c3bfd7e3564980", "drone_race_gates", "racing gates/flags", False),
    ("props", "6ae9b3a1e87041bc8d18ef459493c35a", "drone_race_equipment", "racing gates", False),
    ("props", "90c54a64937f49249e88ff4e25dddbdf", "drone_race_flag", "race flag", False),
    ("props", "a6cccf5af6514f2f9289beeead38fe1b", "construction_asset_pack", "construction props 27k", False),
    ("props", "2f52ea53c58e455f9b69d11f58763c96", "city_props_vol2", "city props 52k", False),
    ("props", "c853eca300e8435d8fe9206bcb524eda", "abandoned_street_lights", "street lights 22k", False),
    ("props", "e0bd9e8f693c496280e0afeb32fece26", "broadcast_tower", "lattice tower, game ready 14k", False),
    ("props", "4b3c733d8bfd4ee2b91dcbcd02670686", "radio_tower", "radio tower 3k", False),
    # ---- map building blocks (abandoned / urbex / bando)
    ("maps", "1d5285f2e0fd4211a27c8042496d5959", "abandoned_warehouse_interior", "618k faces, hero indoor map", False),
    ("maps", "1e40d433ed6f48fb880a0d2172aff7ca", "abandoned_warehouse_denis", "351k faces", False),
    ("maps", "e510537c72a848879171cbbb1ec2f648", "abandoned_factory_rixael", "100k faces", False),
    ("maps", "c08537c06acd46bba24ad8251bcdf941", "abandoned_factory_pasha", "186k faces", False),
    ("maps", "0dafa7aaadfd4666bb4a32776c84b14e", "old_industrial_building", "67k faces", False),
    ("maps", "41ffced19ad44ba58b3ab8bd99f69ab7", "urbex_industrial_interior", "2.6k faces", False),
    ("maps", "fc251a699395458ebc6063f4f0452029", "post_apocalyptic_buildings", "1M faces -> decimate", False),
    ("maps", "3fb7160b6d0c4350a0abc80962c47227", "destroyed_buildings", "1.7M faces -> decimate", False),
    ("maps", "0ed14367314946b298d9a58db66da040", "abandoned_shop", "12.8k", False),
    ("maps", "a0c01ce35a474545b805c0739806aace", "abandoned_house", "12k", False),
    ("maps", "76f8b45993f14303a5071e456b668290", "abandoned_soviet_gas_station", "12.8k", False),
    ("maps", "5310b7d77b70427d936ec4253fff679c", "parking_garage_idmental", "5.4k, freestyle spot", False),
    ("maps", "88c3f49f553f41f59382e0e38781193c", "parking_garage_dylan", "34k", False),
    ("maps", "05229ac1d1f94e6c8cacaad91110c602", "soviet_apartment_lowpoly", "10k, panel block", False),
    ("maps", "dd400ed693cf416e940c5b8e3107205e", "old_residential_building", "277k", False),
    ("maps", "17816ea520cc40db9b094ec7779d2757", "industrial_zone_lowpoly", "79k", False),
    ("maps", "1f50f0d6ec5a493d8e91d7db1106b324", "city_jeandiz", "80k city block", False),
]


def api(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"Token {token}", "User-Agent": "DroneSim/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main():
    token = os.environ.get("SKETCHFAB_TOKEN")
    if not token:
        sys.exit(__doc__)
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    allow_nc = "--all" in sys.argv
    cred_path = os.path.join(OUT, "CREDITS.json")
    os.makedirs(OUT, exist_ok=True)
    credits = json.load(open(cred_path, encoding="utf-8")) if os.path.exists(cred_path) else {}
    for group, uid, slug, note, nc in MODELS:
        if (only and group != only) or (nc and not allow_nc):
            continue
        dst = os.path.join(OUT, group, slug)
        if os.path.isdir(dst) and os.listdir(dst):
            print("skip (exists)", slug); continue
        try:
            info = json.loads(api(f"https://api.sketchfab.com/v3/models/{uid}", token))
            dl = json.loads(api(f"https://api.sketchfab.com/v3/models/{uid}/download", token))
            url = dl["gltf"]["url"]
            with urllib.request.urlopen(url, timeout=600) as r:
                data = r.read()
            os.makedirs(dst, exist_ok=True)
            zipfile.ZipFile(io.BytesIO(data)).extractall(dst)
            credits[uid] = {"slug": slug, "group": group, "title": info.get("name"), "author": info["user"]["displayName"],
                            "author_url": info["user"]["profileUrl"], "license": (info.get("license") or {}).get("label"),
                            "url": info.get("viewerUrl"), "note": note}
            print(f"OK  {group:6s} {slug:34s} {len(data) / 1e6:6.1f} MB  {credits[uid]['license']}")
        except Exception as e:
            print("FAIL", slug, e)
        json.dump(credits, open(cred_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
        time.sleep(1.0)


if __name__ == "__main__":
    main()
