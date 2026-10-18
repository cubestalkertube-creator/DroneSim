"""Download real recorded sounds from Freesound.org (CC0 + CC-BY only) as HQ previews (mp3 ~128 kbps).

Usage: python -I tools/fetch_freesound.py
Writes assets/audio/<category>/<id>_<slug>.mp3 and assets/audio/CREDITS.json (CC-BY needs attribution in-game).
Previews are enough for prototyping; originals (wav/flac) can be fetched later with a Freesound account/API key.
"""
import html, json, os, re, time, urllib.parse, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "assets", "audio")
UA = {"User-Agent": "Mozilla/5.0 (DroneSim asset fetcher)"}
LICENSES = {"cc0": '"Creative Commons 0"', "cc-by": '"Attribution"'}

QUERIES = {
    "motors_fpv": ["fpv drone", "racing drone", "fpv quad", "quadcopter", "brushless motor", "fpv freestyle"],
    "motors_camera_drone": ["dji drone", "drone hover", "drone flyby", "drone takeoff", "drone landing", "mavic", "phantom drone"],
    "motors_heavy_multirotor": ["hexacopter", "octocopter", "large drone", "agricultural drone"],
    "engines_fixed_wing": ["shahed", "two stroke engine", "rc plane flyby", "model airplane engine", "moped engine",
                           "propeller plane flyby", "ultralight aircraft", "glow engine"],
    "props_aero": ["propeller whoosh", "propeller", "fan blade", "rotor wash"],
    "wind": ["wind gust", "wind whoosh", "flyby whoosh", "wind high altitude", "air rush", "wind strong"],
    "impacts": ["drone crash", "plastic crash", "plastic impact", "carbon fiber", "plastic break", "metal impact",
                "glass break", "concrete impact", "branch snap", "propeller strike", "water splash"],
    "electronics": ["esc beep", "motor beep", "beep", "low battery", "arming", "radio transmitter", "rc transmitter",
                    "servo", "gimbal motor"],
    "fpv_video_static": ["radio static", "analog video static", "white noise static", "interference"],
    "ambience": ["city ambience", "industrial ambience", "abandoned building", "factory ambience", "forest ambience",
                 "field ambience", "birds field", "rain ambience", "night crickets", "warehouse ambience", "construction site"],
    "ui": ["ui click", "interface click", "menu select", "button hover", "notification", "whoosh ui", "countdown beep",
           "race start", "checkpoint"],
}
PER_QUERY = 6
MAX_DURATION = float(os.environ.get("DS_MAXDUR", 120))

ATTR = re.compile(r'data-sound-id="(\d+)"\s+data-username="([^"]*)".*?data-mp3="([^"]+)".*?data-title="([^"]*)"'
                  r'.*?data-duration="([\d.]+)"', re.S)


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def slug(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")[:40]


def main():
    credits_path = os.path.join(OUT, "CREDITS.json")
    credits = json.load(open(credits_path, encoding="utf-8")) if os.path.exists(credits_path) else {}
    seen = set(credits)
    only = [c for c in os.environ.get("DS_CATS", "").split(",") if c]  # e.g. DS_CATS=ui,ambience
    for cat, qs in QUERIES.items():
        if only and cat not in only:
            continue
        os.makedirs(os.path.join(OUT, cat), exist_ok=True)
        for q in qs:
            for lic, f in LICENSES.items():
                url = "https://freesound.org/search/?" + urllib.parse.urlencode(
                    {"q": q, "f": f"license:{f}", "s": "Downloads (most first)"})
                try:
                    page = fetch(url).decode("utf-8", "ignore")
                except Exception as e:
                    print("search fail", q, e); continue
                n = 0
                for sid, user, mp3, title, dur in ATTR.findall(page):
                    if n >= PER_QUERY // 2 + (1 if lic == "cc0" else 0):
                        break
                    if sid in seen or float(dur) > MAX_DURATION:
                        continue
                    seen.add(sid)
                    title = html.unescape(title)
                    hq = mp3.replace("-lq.mp3", "-hq.mp3")
                    rel = f"{cat}/{sid}_{slug(title)}.mp3"
                    data = None
                    for attempt, u in enumerate((hq, hq, mp3)):
                        try:
                            data = fetch(u)
                            break
                        except Exception as e:
                            print("  retry", attempt + 1, sid, e)
                            time.sleep(2)
                    if data is None:
                        continue
                    open(os.path.join(OUT, rel), "wb").write(data)
                    credits[sid] = {"file": rel, "title": title, "author": user, "license": lic, "query": q,
                                    "duration_s": float(dur), "url": f"https://freesound.org/people/{user}/sounds/{sid}/"}
                    n += 1
                    json.dump(credits, open(credits_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
                    print(f"{cat:24s} {lic:5s} {float(dur):6.1f}s  {title[:60]}")
                time.sleep(0.2)
        json.dump(credits, open(credits_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print("total sounds:", len(credits))


if __name__ == "__main__":
    main()
