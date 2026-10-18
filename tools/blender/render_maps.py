"""Build maps headless and render aerial previews:  blender -b --factory-startup -P tools/blender/render_maps.py -- [ids...]"""
import bpy, sys, math
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
exec(open(r"D:/DroneSim/tools/blender/map_builder.py", encoding="utf-8").read())
ids = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ids = ids or list(MAPS)
VIEWS = {"training_field": ((-95, -150, 60), (0, -10, 0)), "abandoned_factory": ((-95, -120, 55), (0, -10, 5)),
         "ruined_district": ((-150, -190, 85), (0, -20, 5)), "parking_garage": ((-65, -70, 35), (0, 0, 6))}
for mid in ids:
    mp = MAPS[mid]()
    env = mp.env
    col, st = mp.finalize(preview_props=False, export=True)
    scn = bpy.context.scene
    scn.render.engine = "BLENDER_EEVEE_NEXT"
    scn.render.resolution_x, scn.render.resolution_y = 1280, 720
    scn.view_settings.view_transform = "AgX"
    w = bpy.data.worlds.new("w"); scn.world = w; w.use_nodes = True
    env_tex = w.node_tree.nodes.new("ShaderNodeTexEnvironment")
    env_tex.image = bpy.data.images.load(r"D:/DroneSim/assets/hdri/" + env["hdri"], check_existing=True)
    w.node_tree.links.new(env_tex.outputs["Color"], w.node_tree.nodes["Background"].inputs["Color"])
    sun = bpy.data.lights.new("sun", "SUN"); sun.energy = env["sun"]["intensity"]
    so = bpy.data.objects.new("sun", sun); scn.collection.objects.link(so)
    d = Vector(env["sun"]["dir"]); d = Vector((d.x, -d.z, d.y))
    so.rotation_euler = (-d).to_track_quat("Z", "Y").to_euler()
    cam = bpy.data.cameras.new("c"); cam.lens = 24; cam.clip_end = 3000
    co = bpy.data.objects.new("c", cam); scn.collection.objects.link(co); scn.camera = co
    p, t = VIEWS[mid]
    co.location = p; co.rotation_euler = (Vector(t) - Vector(p)).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = f"D:/DroneSim/docs/previews/map_{mid}.png"
    bpy.ops.render.render(write_still=True)
    for o in list(col.all_objects): bpy.data.objects.remove(o, do_unlink=True)
    for o in (so, co): bpy.data.objects.remove(o, do_unlink=True)
