"""Move off-topic Freesound results (search noise like 'didgeridoo') to assets/audio/_rejected/.

Usage: python -I tools/prune_audio.py      (re-runnable; listen to _rejected/ before deleting it)
"""
import json, os, shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
AUD = os.path.join(ROOT, "assets", "audio")
KEEP = {
    "motors_fpv": "drone fpv quad copter motor uav racing brushless rc whoop",
    "motors_camera_drone": "drone dji mavic phantom quad copter uav hover flyby fly flight",
    "motors_heavy_multirotor": "drone hexa octo copter uav multirotor multicopter",
    "engines_fixed_wing": "engine plane aircraft airplane propeller prop stroke moped rc flyby shahed cessna motor ultralight glow nitro mower",
    "props_aero": "propeller prop fan rotor blade whoosh swoosh wash",
    "wind": "wind gust whoosh air swoosh flyby breeze storm rush",
    "impacts": "crash impact hit break smash plastic metal glass crack snap splash thud drop debris carbon branch concrete shatter",
    "electronics": "beep bleep battery alarm servo motor radio transmitter arm click electronic buzzer chirp gimbal esc warning",
    "fpv_video_static": "static noise interference radio white tv hiss signal",
    "ambience": "ambience ambient atmos atmosphere city street industrial factory forest birds rain crickets night wind room warehouse construction field traffic",
    "ui": "click ui button select menu hover notification beep whoosh interface countdown start swipe confirm blip checkpoint race",
}


def main():
    path = os.path.join(AUD, "CREDITS.json")
    credits = json.load(open(path, encoding="utf-8"))
    rej_dir = os.path.join(AUD, "_rejected")
    moved = 0
    for sid, c in credits.items():
        cat = c["file"].split("/")[0]
        title = (c["title"] + " " + c.get("query", "")).lower() if cat == "_rejected" else c["title"].lower()
        words = KEEP.get(cat, "").split()
        src = os.path.join(AUD, c["file"])
        if cat in KEEP and not any(w in title for w in words) and os.path.exists(src):
            os.makedirs(rej_dir, exist_ok=True)
            dst_rel = "_rejected/" + os.path.basename(c["file"])
            shutil.move(src, os.path.join(AUD, dst_rel))
            c["rejected_from"] = cat
            c["file"] = dst_rel
            moved += 1
            print("reject", cat, "|", c["title"])
    json.dump(credits, open(path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    kept = sum(1 for c in credits.values() if not c["file"].startswith("_rejected"))
    print(f"moved {moved}, kept {kept}")


if __name__ == "__main__":
    main()
