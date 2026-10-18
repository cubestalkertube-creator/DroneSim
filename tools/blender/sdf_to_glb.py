"""Assemble a Gazebo SDF model (links + visuals + meshes) in Blender and export one GLB.

Run:  blender -b --factory-startup -P tools/blender/sdf_to_glb.py -- <model_dir> <out.glb> [--keep-blend]

* Every SDF link becomes an Empty (node) named after the link; rotor links are renamed rotor_<i>
  so the game can spin them (rotate around local +Y in glTF space = SDF +Z).
* Visual meshes (.dae/.stl/.obj) are imported, scaled and posed exactly as in the SDF.
* Box / cylinder / sphere visuals are created as primitives.
* Z-up SDF -> Y-up glTF conversion is done by the glTF exporter.
"""
import math, os, sys, re
import xml.etree.ElementTree as ET
import bpy
from mathutils import Euler, Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
MODEL_DIR, OUT = os.path.abspath(argv[0]), os.path.abspath(argv[1])
KEEP_BLEND = "--keep-blend" in argv


def pose_matrix(el):
    p = el.find("pose") if el is not None else None
    if p is None or not (p.text or "").strip():
        return Matrix.Identity(4)
    v = [float(x) for x in p.text.split()]
    v += [0.0] * (6 - len(v))
    return Matrix.Translation(Vector(v[:3])) @ Euler((v[3], v[4], v[5]), "XYZ").to_matrix().to_4x4()


def resolve(uri):
    uri = uri.strip()
    uri = re.sub(r"^(model|file|package)://[^/]+/", "", uri)
    for cand in (uri, os.path.join("meshes", os.path.basename(uri)), os.path.basename(uri)):
        full = os.path.join(MODEL_DIR, cand)
        if os.path.exists(full):
            return full
    return None


def material(name, rgba, metallic=0.0, rough=0.5):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    return m


DEFAULT_MAT = None


def import_mesh(path):
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".dae":
        bpy.ops.wm.collada_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    else:
        print("skip unsupported", path)
        return []
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.type == "MESH" and not o.data.materials:
            o.data.materials.append(DEFAULT_MAT)
    return new


def visual_object(vis, name):
    geom = vis.find("geometry")
    if geom is None:
        return []
    mesh = geom.find("mesh")
    if mesh is not None:
        path = resolve(mesh.findtext("uri", ""))
        if not path:
            print("missing mesh", mesh.findtext("uri"))
            return []
        objs = import_mesh(path)
        sc = mesh.findtext("scale")
        holder = bpy.data.objects.new(name, None)
        bpy.context.scene.collection.objects.link(holder)
        if sc:
            holder.scale = [float(x) for x in sc.split()]
        roots = [o for o in objs if o.parent is None or o.parent not in objs]
        # Blender converts Y_UP collada to Z_UP, Gazebo does not -> undo it to keep the SDF poses valid
        y_up = path.lower().endswith(".dae") and "<up_axis>Y_UP" in open(path, errors="ignore").read(4096)
        for o in roots:
            if y_up:
                o.matrix_world = Matrix.Rotation(-math.pi / 2, 4, "X") @ o.matrix_world
            o.parent = holder
        return [holder]
    for kind in ("box", "cylinder", "sphere"):
        g = geom.find(kind)
        if g is None:
            continue
        if kind == "box":
            s = [float(x) for x in g.findtext("size", "1 1 1").split()]
            bpy.ops.mesh.primitive_cube_add(size=1)
            o = bpy.context.active_object
            o.scale = s
        elif kind == "cylinder":
            bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=float(g.findtext("radius", "0.5")),
                                                depth=float(g.findtext("length", "1")))
            o = bpy.context.active_object
        else:
            bpy.ops.mesh.primitive_uv_sphere_add(radius=float(g.findtext("radius", "0.5")))
            o = bpy.context.active_object
        o.name = name
        o.data.materials.append(DEFAULT_MAT)
        return [o]
    return []


def main():
    global DEFAULT_MAT
    bpy.ops.wm.read_factory_settings(use_empty=True)
    DEFAULT_MAT = material("dark_plastic", (0.06, 0.06, 0.065, 1), 0.0, 0.45)
    sdf = ET.parse(os.path.join(MODEL_DIR, "model.sdf")).getroot()
    model = sdf.find("model")
    root = bpy.data.objects.new("drone_root", None)
    bpy.context.scene.collection.objects.link(root)
    # turning direction from motor plugins: <linkName>rotor_0</linkName> ... <turningDirection>ccw</turningDirection>
    spin = {}
    for plug in model.iter("plugin"):
        ln, td = plug.findtext("linkName"), plug.findtext("turningDirection")
        if ln and td:
            spin[ln.strip()] = td.strip().lower()
    rotor_i = 0
    for link in model.findall("link"):
        lname = link.get("name")
        is_rotor = bool(re.search(r"rotor|prop", lname, re.I))
        node_name = f"rotor_{rotor_i}" if is_rotor else lname.replace("/", "_")
        if is_rotor:
            rotor_i += 1
        node = bpy.data.objects.new(node_name, None)
        bpy.context.scene.collection.objects.link(node)
        node.parent = root
        node.matrix_basis = pose_matrix(link)
        node["sdf_link"] = lname
        if is_rotor and lname in spin:
            node["spin"] = spin[lname]
        for vis in link.findall("visual"):
            vname = vis.get("name", "v")
            parent, vpose = node, pose_matrix(vis)
            if not is_rotor and re.search(r"propeller|prop_", vname, re.I):
                # props baked into the body link (e.g. Bebop 2): give each its own rotor node
                parent = bpy.data.objects.new(f"rotor_{rotor_i}", None)
                bpy.context.scene.collection.objects.link(parent)
                parent.parent = node
                parent.matrix_basis = Matrix.Translation(vpose.to_translation())
                vpose = Matrix.Translation(-vpose.to_translation()) @ vpose
                rotor_i += 1
            for o in visual_object(vis, (node_name + "_" + vname)[:60]):
                o.parent = parent
                o.matrix_parent_inverse = Matrix.Identity(4)
                o.matrix_basis = vpose @ Matrix.Diagonal(o.scale.to_4d())
    # rotors without a plugin-defined direction: PX4 convention (quad X: front-right & rear-left CCW; hex: alternate)
    rotors = [o for o in bpy.data.objects if re.fullmatch(r"rotor_\d+", o.name)]
    if rotors and any("spin" not in o for o in rotors):
        bpy.context.view_layer.update()
        pos = {o: (o.matrix_world.translation.x, o.matrix_world.translation.y) for o in rotors}
        if len(rotors) == 4:
            for o in rotors:
                x, y = pos[o]
                o["spin"] = "ccw" if x * y < 0 else "cw"
        else:
            order = sorted(rotors, key=lambda o: math.atan2(pos[o][1], pos[o][0]))
            for k, o in enumerate(order):
                o["spin"] = "ccw" if k % 2 == 0 else "cw"
    # game budget: decimate dense CAD meshes (target ~45k faces total)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    total = sum(len(o.data.polygons) for o in meshes)
    if total > 45000:
        for o in meshes:
            n = len(o.data.polygons)
            if n > 1500:
                d = o.modifiers.new("decimate", "DECIMATE")
                d.ratio = max(0.04, min(1.0, max(45000 / total, 12000 / n)))  # thin parts (legs/tubes) need >=12k faces
    # SDF forward is +X; DroneSim convention is Blender +Y forward (= glTF -Z)
    root.rotation_euler = (0, 0, math.pi / 2)
    # put the lowest point of the model on the ground plane, origin at geometric centre in XY
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in bpy.data.objects if o.type == "MESH" for c in o.bound_box]
    if pts:
        mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        root.location = (-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, 0)  # keep origin at frame centre (CG)
        print(f"BBOX_M {mx.x - mn.x:.3f} x {mx.y - mn.y:.3f} x {mx.z - mn.z:.3f}  rotors={rotor_i}")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True,
                              export_extras=True)
    if KEEP_BLEND:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.splitext(OUT)[0] + ".blend")


main()
