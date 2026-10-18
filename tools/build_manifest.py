"""Scan assets/ and write assets/manifest.json - the single index the game loads at startup.

Usage: python -I tools/build_manifest.py
"""
import json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
A = os.path.join(ROOT, "assets")


def rel(p):
    return os.path.relpath(p, A).replace("\\", "/")


def size(p):
    return sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(p) for f in fs) if os.path.isdir(p) else os.path.getsize(p)


def main():
    presets = json.load(open(os.path.join(A, "presets", "drones.json"), encoding="utf-8"))["drones"]
    drones = [{"id": d["id"], "name": d["name"], "class": d["class"], "model": d["model"], "preset": "presets/drones.json#" + d["id"],
               "preview": f"../docs/previews/ui/{d['id']}.png", "source": d.get("source", "custom"),
               "bytes": size(os.path.join(A, d["model"]))} for d in presets]
    maps = []
    for mid in sorted(os.listdir(os.path.join(A, "maps"))):
        j = os.path.join(A, "maps", mid, mid + ".json")
        if not os.path.exists(j):
            continue
        L = json.load(open(j, encoding="utf-8"))
        maps.append({"id": mid, "title": L["title"], "geometry": f"maps/{mid}/{mid}.glb", "layout": f"maps/{mid}/{mid}.json",
                     "preview": f"../docs/previews/map_{mid}.png", "hdri": "hdri/" + L["env"]["hdri"], "difficulty": L["env"].get("difficulty"),
                     "description": L["env"].get("description"), "spawns": len(L["spawns"]), "gates": len(L["gates"]),
                     "props": sorted({p["asset"] for p in L["props"]}), "textures": sorted({m["tex"] for m in L["materials"].values() if m.get("tex")})})
    hdri = sorted(rel(os.path.join(A, "hdri", f)) for f in os.listdir(os.path.join(A, "hdri")) if f.endswith(".hdr"))
    tex = {}
    for t in sorted(os.listdir(os.path.join(A, "textures"))):
        d = os.path.join(A, "textures", t)
        fs = os.listdir(d)
        pick = lambda key: next((f"textures/{t}/{f}" for f in fs if key in f), None)
        tex[t] = {"diff": pick("_diff_"), "normal_gl": pick("_nor_gl_"), "arm": pick("_arm_"), "source": "ambientCG (CC0)" if t.startswith("acg_") else "Poly Haven (CC0)"}
    props = {}
    for p in sorted(os.listdir(os.path.join(A, "props"))):
        g = os.path.join(A, "props", p, p + ".gltf")
        if os.path.exists(g):
            props[p] = {"gltf": f"props/{p}/{p}.gltf", "bytes": size(os.path.join(A, "props", p)), "source": "Poly Haven (CC0)",
                        "heavy": size(os.path.join(A, "props", p)) > 60e6}
    audio = {}
    adir = os.path.join(A, "audio")
    credits = json.load(open(os.path.join(adir, "CREDITS.json"), encoding="utf-8")) if os.path.exists(os.path.join(adir, "CREDITS.json")) else {}
    for c in sorted(os.listdir(adir)):
        d = os.path.join(adir, c)
        if os.path.isdir(d) and not c.startswith("_"):
            audio[c] = sorted(f"audio/{c}/{f}" for f in os.listdir(d) if f.endswith((".mp3", ".ogg", ".wav")))
    man = {"version": 1, "conventions": {"units": "meters", "game_space": "+Y up, -Z forward (glTF)",
                                          "drone_nodes": "rotor_<i> (+_blades, _blur), fpv_cam, elevon_L/R; extras: spin, diameter_m, uptilt_deg"},
           "drones": drones, "maps": maps, "hdri": hdri, "textures": tex, "props": props, "audio": audio,
           "credits": ["audio/CREDITS.json", "_sketchfab/CREDITS.json", "../docs/ASSETS.md"]}
    json.dump(man, open(os.path.join(A, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"drones {len(drones)}, maps {len(maps)}, hdri {len(hdri)}, textures {len(tex)}, props {len(props)}, "
          f"audio {sum(map(len, audio.values()))} in {len(audio)} groups, credits {len(credits)}")


if __name__ == "__main__":
    main()
