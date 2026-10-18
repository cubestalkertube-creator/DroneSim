"""Render a 3/4 studio preview of a GLB.  blender -b --factory-startup -P render_preview.py -- in.glb out.png [size]"""
import math, sys
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = argv[0], argv[1]
size = int(argv[2]) if len(argv) > 2 else 768
transparent = "--transparent" in argv  # UI cut-out: no floor, alpha background

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in list(bpy.data.objects):
    if "_blur" in o.name:
        bpy.data.objects.remove(o, do_unlink=True)
bpy.context.view_layer.update()
pts = [o.matrix_world @ Vector(c) for o in bpy.data.objects if o.type == "MESH" for c in o.bound_box]
mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
c, r = (mn + mx) / 2, (mx - mn).length / 2
tris = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
print(f"PREVIEW bbox {mx.x-mn.x:.3f} x {mx.y-mn.y:.3f} x {mx.z-mn.z:.3f} m, faces={tris}")

scn = bpy.context.scene
scn.render.engine = "BLENDER_EEVEE_NEXT"
scn.render.resolution_x = scn.render.resolution_y = size
scn.render.film_transparent = transparent
scn.view_settings.view_transform = "AgX"
world = bpy.data.worlds.new("w"); scn.world = world; world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.32, 0.34, 0.37, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.6

bpy.ops.mesh.primitive_plane_add(size=r * 40, location=(c.x, c.y, mn.z))
floor = bpy.context.active_object
floor.hide_render = transparent
fm = bpy.data.materials.new("floor"); fm.use_nodes = True
fm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.45, 0.46, 0.48, 1)
floor.data.materials.append(fm)

for loc, e in (((3, -3, 4), 900), ((-4, -1, 2), 300), ((0, 4, 3), 500)):
    L = bpy.data.lights.new("l", "AREA"); L.energy = e * r * r; L.size = r * 3
    o = bpy.data.objects.new("l", L); scn.collection.objects.link(o)
    o.location = c + Vector(loc) * r
    o.rotation_euler = (c - o.location).to_track_quat("-Z", "Y").to_euler()

cam = bpy.data.cameras.new("cam"); cam.lens = 60
co = bpy.data.objects.new("cam", cam); scn.collection.objects.link(co); scn.camera = co
d = Vector((1.0, -1.25, 0.75)).normalized()
co.location = c + d * r * 3.4
co.rotation_euler = (c - co.location).to_track_quat("-Z", "Y").to_euler()
scn.render.filepath = dst
bpy.ops.render.render(write_still=True)
