"""Download CC0 assets from Poly Haven (https://polyhaven.com) into assets/.

Usage:  python -I tools/fetch_polyhaven.py [--res 2k]
All Poly Haven assets are CC0 (public domain) - no attribution required.
"""
import json, os, sys, urllib.request, concurrent.futures as cf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
API = "https://api.polyhaven.com"
UA = {"User-Agent": "DroneSim-asset-fetcher/1.0"}

HDRIS = {
    # sky / lighting for maps + menu showroom
    "kloofendal_48d_partly_cloudy_puresky": ["4k"], "industrial_sunset_puresky": ["4k"],
    "overcast_soil_puresky": ["2k"], "belfast_sunset_puresky": ["2k"], "kloppenheim_02_puresky": ["2k"],
    "mud_road_puresky": ["2k"], "autumn_field_puresky": ["2k"], "approaching_storm": ["2k"],
    "kloofendal_overcast_puresky": ["2k"], "kloofendal_misty_morning_puresky": ["2k"],
    "qwantani_night_puresky": ["2k"], "drackenstein_quarry_puresky": ["2k"],
    "abandoned_tank_farm_04": ["2k"], "abandoned_parking": ["2k"], "abandoned_hall_01": ["2k"],
    "abandoned_slipway": ["2k"], "abandoned_hopper_terminal_04": ["2k"], "empty_warehouse_01": ["2k"],
    "construction_yard": ["2k"], "old_bus_depot": ["2k"], "freight_station": ["2k"],
    "parking_garage": ["2k"], "small_hangar_01": ["4k"], "aerodynamics_workshop": ["2k"],
    "machine_shop_02": ["2k"], "skylit_garage": ["2k"], "rooftop_night": ["2k"],
    "snowy_park_01": ["2k"], "snow_field": ["2k"], "quarry_01": ["2k"], "rostock_laage_airport": ["2k"],
    "studio_small_09": ["2k"],
}

TEXTURES = [
    "concrete_floor_worn_001", "concrete_floor_damaged_01", "cracked_concrete_wall", "concrete_wall_003",
    "concrete_wall_008", "dirty_concrete", "rough_concrete", "rebar_reinforced_concrete", "hangar_concrete_floor",
    "garage_floor", "factory_wall", "factory_brick", "broken_brick_wall", "red_brick_03", "brick_wall_001",
    "damaged_plaster", "rough_plaster_broken", "plastered_wall_04", "rusty_metal_02", "rusty_metal_sheet",
    "metal_grate_rusty", "corrugated_iron_02", "worn_corrugated_iron", "box_profile_metal_sheet",
    "painted_metal_shutter", "metal_plate", "asphalt_02", "asphalt_track", "asphalt_pit_lane", "clean_asphalt",
    "aerial_asphalt_01", "pavement_02", "gravel_concrete_03", "gravelly_sand", "dirt", "brown_mud_leaves_01",
    "forest_ground_04", "leafy_grass", "sparse_grass", "grass_path_2", "aerial_grass_rock", "rocky_terrain_02",
    "snow_02", "mud_cracked_dry_03", "burned_ground_01", "weathered_planks", "wood_peeling_paint_weathered",
    "rubber_tiles", "plywood", "polystyrene",
]

MODELS = [
    "Barrel_01", "Barrel_02", "barrel_03", "concrete_road_barrier", "concrete_road_barrier_02", "old_tyre",
    "wooden_crate_01", "wooden_crate_02", "cardboard_box_01", "modular_industrial_pipes_01", "modular_pipes",
    "modular_airduct_rectangular_01", "modular_airduct_circular_01", "modular_chainlink_fence",
    "modular_electricity_poles", "modular_electric_cables", "modular_fire_escape", "modular_factory_facade",
    "modular_urban_apartments_facade", "modular_metal_gutter", "street_lamp_01", "street_lamp_02",
    "large_iron_gate", "rollershutter_door", "exterior_aircon_unit", "utility_box_01", "utility_box_02",
    "power_box_01", "metal_trash_can", "fire_hydrant", "water_manhole_cover", "security_camera_01",
    "industrial_wall_lamp", "hanging_industrial_lamp", "caged_hanging_light", "security_light",
    "steel_frame_shelves_01", "metal_tool_chest", "portable_generator", "small_lpg_tank", "ladder_sectioned_01",
    "covered_car", "rusted_wheel_rim_01", "can_rusted", "dead_tree_trunk", "dead_tree_trunk_02",
    "pine_tree_01", "fir_tree_01", "tree_small_02", "shrub_01", "shrub_04", "grass_medium_01", "grass_medium_02",
    "boulder_01", "rock_moss_set_01", "rock_09", "WetFloorSign_01", "plastic_monobloc_chair_01",
    "metal_office_desk", "wooden_picnic_table", "Camera_01", "gamepad",
]


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def save(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return 0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = get(url)
    with open(path + ".part", "wb") as f:
        f.write(data)
    os.replace(path + ".part", path)
    return len(data)


def jobs(res):
    out = []
    for hid, resl in HDRIS.items():
        files = json.loads(get(f"{API}/files/{hid}"))
        for r in resl:
            f = files["hdri"][r]["hdr"]
            out.append((f["url"], f"{ROOT}/assets/hdri/{hid}_{r}.hdr"))
        # small tonemapped preview for the map-select UI
        out.append((f"https://cdn.polyhaven.com/asset_img/thumbs/{hid}.png?width=512", f"{ROOT}/assets/hdri/thumbs/{hid}.png"))
    for tid in TEXTURES:
        files = json.loads(get(f"{API}/files/{tid}"))
        g = files["gltf"][res]["gltf"]
        for rel, inc in g.get("include", {}).items():
            out.append((inc["url"], f"{ROOT}/assets/textures/{tid}/{os.path.basename(rel)}"))
    for mid in MODELS:
        files = json.loads(get(f"{API}/files/{mid}"))
        g = files["gltf"][res]["gltf"]
        out.append((g["url"], f"{ROOT}/assets/props/{mid}/{mid}.gltf"))
        for rel, inc in g.get("include", {}).items():
            out.append((inc["url"], f"{ROOT}/assets/props/{mid}/{rel}"))
    return out


def main():
    res = sys.argv[sys.argv.index("--res") + 1] if "--res" in sys.argv else "2k"
    js = jobs(res)
    print(f"{len(js)} files queued")
    total = 0
    with cf.ThreadPoolExecutor(8) as ex:
        for (url, path), fut in zip(js, [ex.submit(save, u, p) for u, p in js]):
            try:
                total += fut.result()
            except Exception as e:  # keep going, report at the end
                print("FAIL", url, e)
    print(f"done, {total / 1e6:.1f} MB downloaded")


if __name__ == "__main__":
    main()
