"""Parametric, real-scale drone models for DroneSim (run inside Blender 4.5+/5.x).

Conventions (all models):
  * metres, Blender +Z up, +Y = drone FORWARD  ->  glTF/three.js: +Y up, -Z forward.
  * origin = geometric centre of the frame (approx. CG), bottom of model may be below 0.
  * rotors are Empties named  rotor_<i>  (spin around local Z; custom prop "spin" = "cw"/"ccw").
    Each rotor has two children: <...>_blades (real prop) and <...>_blur (motion-blur disc, hidden by default).
  * Betaflight motor order (props-in default): 0 = rear-right CW, 1 = front-right CCW, 2 = rear-left CCW, 3 = front-left CW.
  * camera Empty "fpv_cam" marks the FPV camera eye point; its local -Z looks forward-ish after uptilt (as Blender camera).

Usage inside Blender:
    exec(open(r"D:/DroneSim/tools/blender/drone_builder.py").read())
    build_all(export_dir=r"D:/DroneSim/assets/models/drones")
"""
import math, os
import bpy, bmesh
from mathutils import Matrix, Vector, Euler

TEX_DIR = r"D:/DroneSim/assets/models/drones/textures"
SCENE = "DroneSim_Build"


# ----------------------------------------------------------------------------- scene / helpers
def scene():
    if not bpy.context.window:  # background mode: no window to switch, build in the active scene
        return bpy.context.scene
    sc = bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)
    if bpy.context.window:
        bpy.context.window.scene = sc
    return sc


def collection(name):
    sc = scene()
    col = bpy.data.collections.get(name)
    if col:
        for o in list(col.all_objects):
            bpy.data.objects.remove(o, do_unlink=True)
    else:
        col = bpy.data.collections.new(name)
        sc.collection.children.link(col)
    return col


CUR = {"col": None}


def link(o, parent=None):
    CUR["col"].objects.link(o)
    if parent is not None:
        o.parent = parent
    return o


def empty(name, parent=None, loc=(0, 0, 0), rot=(0, 0, 0)):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.02
    e.location, e.rotation_euler = loc, rot
    return link(e, parent)


def obj_from_bm(name, bm, mat, parent=None, loc=(0, 0, 0), rot=(0, 0, 0), smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    o = bpy.data.objects.new(name, me)
    if mat:
        me.materials.append(mat)
    o.location, o.rotation_euler = loc, rot
    return link(o, parent)


def bevel(o, w=0.0006, seg=2, angle=40):
    m = o.modifiers.new("bevel", "BEVEL")
    m.width, m.segments, m.limit_method = w, seg, "ANGLE"
    m.angle_limit = math.radians(angle)
    m.harden_normals = False
    return o


def box(name, size, loc=(0, 0, 0), mat=None, parent=None, rot=(0, 0, 0), bev=0.0006):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    o = obj_from_bm(name, bm, mat, parent, loc, rot)
    return bevel(o, bev) if bev else o


def cyl(name, r, h, loc=(0, 0, 0), mat=None, parent=None, rot=(0, 0, 0), seg=24, bev=0.0, r2=None, smooth=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h)
    o = obj_from_bm(name, bm, mat, parent, loc, rot, smooth=smooth)
    if smooth:
        o.data.set_sharp_from_angle(angle=math.radians(35)) if hasattr(o.data, "set_sharp_from_angle") else None
    return bevel(o, bev) if bev else o


def sphere(name, r, loc=(0, 0, 0), mat=None, parent=None, scale=(1, 1, 1)):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=r)
    bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
    return obj_from_bm(name, bm, mat, parent, loc, smooth=True)


def extrude_outline(name, pts, thick, z=0.0, mat=None, parent=None, bev=0.0005):
    """2D outline (XY, CCW) extruded along +Z from z to z+thick."""
    bm = bmesh.new()
    vs = [bm.verts.new((x, y, z)) for x, y in pts]
    f = bm.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    bmesh.ops.translate(bm, vec=(0, 0, thick), verts=[v for v in ext["geom"] if isinstance(v, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = obj_from_bm(name, bm, mat, parent)
    return bevel(o, bev, 2, 30) if bev else o


def rounded_rect(w, h, r, n=5):
    pts = []
    for cx, cy, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def lathe(name, profile, mat=None, parent=None, loc=(0, 0, 0), rot=(0, 0, 0), seg=48):
    """Revolve a closed (r,z) profile around Z (ducts, spinners, nose cones)."""
    bm = bmesh.new()
    vs = [bm.verts.new((r, 0, z)) for r, z in profile]
    es = [bm.edges.new((vs[i], vs[(i + 1) % len(vs)])) for i in range(len(vs))]
    bmesh.ops.spin(bm, geom=vs + es, cent=(0, 0, 0), axis=(0, 0, 1), angle=math.tau, steps=seg, use_duplicate=False)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bm(name, bm, mat, parent, loc, rot, smooth=True)


def join(objs, name):
    """Apply modifiers and join objects into one mesh (keeps draw-calls low for the game)."""
    objs = [o for o in objs if o]
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    mats, parent = [], objs[0].parent
    inv = parent.matrix_world.inverted() if parent else Matrix.Identity(4)
    for o in objs:
        ev = o.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev, depsgraph=dg)  # real datablock, safe to modify
        me.transform(inv @ o.matrix_world)
        off = len(mats)
        mats.extend(me.materials[:] or [None])
        tmp = bmesh.new(); tmp.from_mesh(me)
        for f in tmp.faces:
            f.material_index += off
        tmp.to_mesh(me); tmp.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    # dedupe materials
    uniq = []
    for m in mats:
        if m not in uniq:
            uniq.append(m)
    remap = [uniq.index(m) for m in mats]
    for m in uniq:
        me.materials.append(m)  # None slots are allowed
    for p in me.polygons:
        p.material_index = remap[p.material_index] if p.material_index < len(remap) else 0
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    o = bpy.data.objects.new(name, me)
    return link(o, parent)


# ----------------------------------------------------------------------------- materials & textures
def _img(name, w, h, fn, alpha=False):
    img = bpy.data.images.get(name)
    if img:
        return img
    import numpy as np
    img = bpy.data.images.new(name, w, h, alpha=alpha)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    px = fn(x / w, y / h)  # -> HxWx4 float
    img.pixels.foreach_set(px.astype(np.float32).ravel())
    os.makedirs(TEX_DIR, exist_ok=True)
    img.filepath_raw = os.path.join(TEX_DIR, name + ".png")
    img.file_format = "PNG"
    img.save()
    return img


def carbon_tex():
    import numpy as np

    def fn(u, v):
        n = 32  # tows across the texture (3K twill look)
        cu, cv = (u * n) % 1.0, (v * n) % 1.0
        iu, iv = np.floor(u * n), np.floor(v * n)
        over = ((iu + iv) // 2 % 2) == 0  # 2x2 twill
        fib = np.where(over, 0.5 + 0.5 * np.cos((cv - 0.5) * math.pi), 0.5 + 0.5 * np.cos((cu - 0.5) * math.pi))
        shade = 0.035 + 0.05 * fib * np.where(over, 1.0, 0.7)
        noise = np.random.default_rng(1).normal(0, 0.004, u.shape)
        c = np.clip(shade + noise, 0, 1)
        return np.stack([c, c, c * 1.05, np.ones_like(c)], -1)
    return _img("carbon_3k", 512, 512, fn)


def blur_tex():
    import numpy as np

    def fn(u, v):
        x, y = u - 0.5, v - 0.5
        r = np.sqrt(x * x + y * y) * 2
        a = np.clip((r - 0.12) / 0.1, 0, 1) * np.clip((1.0 - r) / 0.06, 0, 1)
        a *= 0.18 + 0.12 * np.exp(-((r - 0.75) ** 2) / 0.02)
        c = np.ones_like(r) * 0.85
        return np.stack([c, c, c, a], -1)
    return _img("prop_blur_disc", 256, 256, fn, alpha=True)


def mat(name, color=(0.5, 0.5, 0.5, 1), metal=0.0, rough=0.5, alpha=1.0, emit=None, tex=None, transmission=0.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    if transmission:
        b.inputs["Transmission Weight"].default_value = transmission
    if emit:
        b.inputs["Emission Color"].default_value = emit
        b.inputs["Emission Strength"].default_value = 4.0
    if tex is not None:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = tex
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
        if tex.alpha_mode != "NONE" and alpha < 1.0:
            nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
    if alpha < 1.0:
        if tex is None:
            b.inputs["Alpha"].default_value = alpha
        if hasattr(m, "surface_render_method"):
            m.surface_render_method = "BLENDED"
        else:
            m.blend_method = "BLEND"
    return m


def M():
    return {
        "carbon": mat("carbon_fiber", (0.04, 0.04, 0.045, 1), 0.0, 0.32, tex=carbon_tex()),
        "alu_red": mat("anodized_red", (0.55, 0.03, 0.03, 1), 0.9, 0.3),
        "alu_purple": mat("anodized_purple", (0.25, 0.05, 0.45, 1), 0.9, 0.3),
        "alu_gray": mat("anodized_gunmetal", (0.18, 0.18, 0.2, 1), 0.9, 0.35),
        "steel": mat("steel", (0.62, 0.62, 0.64, 1), 1.0, 0.25),
        "copper": mat("copper_winding", (0.72, 0.36, 0.18, 1), 1.0, 0.35),
        "black_plastic": mat("black_plastic", (0.02, 0.02, 0.022, 1), 0.0, 0.55),
        "gray_plastic": mat("gray_plastic_matte", (0.32, 0.33, 0.35, 1), 0.0, 0.6),
        "light_gray": mat("light_gray_plastic", (0.62, 0.63, 0.64, 1), 0.0, 0.45),
        "white_plastic": mat("white_plastic", (0.8, 0.8, 0.8, 1), 0.0, 0.4),
        "tpu_orange": mat("tpu_orange", (0.85, 0.25, 0.02, 1), 0.0, 0.7),
        "tpu_black": mat("tpu_black", (0.03, 0.03, 0.03, 1), 0.0, 0.8),
        "pcb": mat("pcb_black", (0.02, 0.03, 0.025, 1), 0.2, 0.4),
        "chip": mat("ic_chip", (0.05, 0.05, 0.05, 1), 0.0, 0.3),
        "gold": mat("gold_pads", (0.9, 0.7, 0.3, 1), 1.0, 0.2),
        "glass": mat("lens_glass", (0.02, 0.03, 0.05, 1), 0.2, 0.05),
        "lens_ring": mat("lens_ring_blue", (0.05, 0.12, 0.35, 1), 0.9, 0.3),
        "prop_pink": mat("prop_pc_pink", (0.95, 0.15, 0.45, 1), 0.0, 0.25, alpha=0.88),
        "prop_cyan": mat("prop_pc_cyan", (0.1, 0.7, 0.85, 1), 0.0, 0.25, alpha=0.88),
        "prop_gray": mat("prop_gray", (0.12, 0.12, 0.13, 1), 0.0, 0.35),
        "prop_blur": mat("prop_blur", (1, 1, 1, 1), 0.0, 0.5, alpha=0.5, tex=blur_tex()),
        "lipo_wrap": mat("lipo_wrap_yellow", (0.85, 0.6, 0.02, 1), 0.0, 0.35),
        "lipo_label": mat("lipo_label_black", (0.03, 0.03, 0.03, 1), 0.0, 0.3),
        "silicone_red": mat("silicone_wire_red", (0.6, 0.02, 0.02, 1), 0.0, 0.6),
        "silicone_black": mat("silicone_wire_black", (0.02, 0.02, 0.02, 1), 0.0, 0.6),
        "xt60": mat("xt60_yellow", (0.9, 0.75, 0.05, 1), 0.0, 0.45),
        "strap": mat("battery_strap", (0.05, 0.05, 0.05, 1), 0.0, 0.9),
        "grip": mat("grip_pad", (0.1, 0.1, 0.1, 1), 0.0, 0.95),
        "led_green": mat("led_green", (0.1, 1, 0.3, 1), emit=(0.1, 1, 0.3, 1)),
        "led_red": mat("led_red", (1, 0.05, 0.05, 1), emit=(1, 0.05, 0.05, 1)),
        "drone_gray": mat("consumer_drone_gray", (0.22, 0.23, 0.24, 1), 0.0, 0.42),
        "drone_dark": mat("consumer_drone_dark", (0.06, 0.06, 0.065, 1), 0.0, 0.4),
        "olive": mat("military_olive_drab", (0.2, 0.22, 0.14, 1), 0.0, 0.7),
        "camo_gray": mat("military_gray", (0.36, 0.38, 0.38, 1), 0.0, 0.65),
        "foam_black": mat("composite_black", (0.05, 0.05, 0.05, 1), 0.0, 0.7),
        "wood_prop": mat("prop_wood_composite", (0.25, 0.15, 0.07, 1), 0.0, 0.55),
    }


# ----------------------------------------------------------------------------- parts
def make_prop_blades(name, diameter, blades, pitch_in, cw, mat_, parent, hub_r=0.0065, chord_k=0.2, hub_h=0.007):
    """Real propeller blade geometry: chord distribution, geometric twist from pitch, swept blade."""
    R = diameter / 2
    P = pitch_in * 0.0254
    sgn = -1.0 if cw else 1.0
    bm = bmesh.new()
    n_sec = 12
    for b in range(blades):
        ang = b * math.tau / blades
        rows = []
        for i in range(n_sec):
            t = i / (n_sec - 1)
            r = hub_r * 0.9 + (R - hub_r * 0.9) * (1 - (1 - t) ** 1.15)
            rr = r / R
            chord = R * chord_k * (0.55 + 1.6 * rr * math.exp(-2.6 * rr)) * (1 - 0.55 * max(0, (rr - 0.86) / 0.14) ** 1.6)
            chord = max(chord, R * 0.025)
            pitch_a = math.atan2(P, math.tau * r)
            thick = max(0.0012 * (1 - 0.6 * rr), 0.00045) * (diameter / 0.13) ** 0.5
            sweep = -0.18 * chord * rr ** 2
            # thin cambered airfoil around (0,0): (chordwise y, thickness z); leading edge at +y
            prof = [(0.5, 0.0), (0.38, 0.6), (0.15, 0.95), (-0.15, 0.75), (-0.5, 0.0), (-0.15, -0.15), (0.15, -0.1), (0.38, -0.05)]
            row = []
            for py, pz in prof:
                y, z = py * chord + sweep, pz * thick
                # rotate by pitch about radial axis (leading edge up)
                yy = y * math.cos(pitch_a) - z * math.sin(pitch_a)
                zz = y * math.sin(pitch_a) + z * math.cos(pitch_a)
                v = Vector((r, sgn * yy, zz))
                v.rotate(Matrix.Rotation(ang, 3, "Z"))
                row.append(bm.verts.new(v))
            rows.append(row)
        k = len(rows[0])
        for i in range(n_sec - 1):
            for j in range(k):
                a, b2, c, d = rows[i][j], rows[i][(j + 1) % k], rows[i + 1][(j + 1) % k], rows[i + 1][j]
                bm.faces.new((a, b2, c, d) if sgn > 0 else (d, c, b2, a))
        bm.faces.new(rows[-1] if sgn > 0 else list(reversed(rows[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = obj_from_bm(name, bm, mat_, parent, smooth=True)
    hub = cyl(name + "_hub", hub_r, hub_h, (0, 0, 0), mat_, parent, seg=20)
    return join([o, hub], name)


def make_motor(name, parent, stator_d_mm=23, stator_h_mm=6, bell_mat=None, m=None):
    """Brushless outrunner (e.g. 2306): base, windings visible through slots, bell, shaft. Top of bell at z=h."""
    s = stator_d_mm / 1000
    bell_r = s / 2 + 0.0028
    bell_h = stator_h_mm / 1000 + 0.009
    parts = [
        cyl(name + "_base", bell_r * 0.95, 0.003, (0, 0, 0.0015), m["alu_gray"], parent, seg=28),
        cyl(name + "_stator", s / 2 + 0.0005, bell_h * 0.7, (0, 0, 0.003 + bell_h * 0.35), m["copper"], parent, seg=24),
        cyl(name + "_bell_low", bell_r, bell_h * 0.42, (0, 0, 0.0035 + bell_h * 0.21), bell_mat, parent, seg=32),
        cyl(name + "_bell_top", bell_r, bell_h * 0.3, (0, 0, 0.0035 + bell_h * 0.85), bell_mat, parent, seg=32, r2=bell_r * 0.82),
    ]
    # bell spokes between lower ring and top cap (open windows show copper)
    for i in range(6):
        a = i * math.tau / 6
        parts.append(box(name + f"_spoke{i}", (0.0035, bell_r * 0.5, bell_h * 0.25),
                         (math.sin(a) * bell_r * 0.82, math.cos(a) * bell_r * 0.82, 0.0035 + bell_h * 0.58), bell_mat, parent, (0, 0, -a), 0))
    parts.append(cyl(name + "_shaft", 0.0025, 0.009, (0, 0, 0.0035 + bell_h + 0.0045), m["steel"], parent, seg=12))
    return join(parts, name), 0.0035 + bell_h


def make_rotor(idx, parent, pos, cw, diameter, pitch_in, blades, prop_mat, top_z, nut=True, m=None):
    r = empty(f"rotor_{idx}", parent, (pos[0], pos[1], top_z + 0.002))
    r["spin"] = "cw" if cw else "ccw"
    r["diameter_m"] = diameter
    r["pitch_in"] = pitch_in
    make_prop_blades(f"rotor_{idx}_blades", diameter, blades, pitch_in, cw, prop_mat, r)
    if nut:
        cyl(f"rotor_{idx}_nut", 0.0042, 0.006, (0, 0, 0.005), m["steel"], r, seg=6, smooth=False)
    # motion blur disc (two-sided quad with radial alpha texture); hidden, game shows it above ~1500 rpm
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=diameter / 2)
    bm.loops.layers.uv.new("UVMap")
    uv = bm.loops.layers.uv.active
    for f in bm.faces:
        for l in f.loops:
            l[uv].uv = (l.vert.co.x / diameter + 0.5, l.vert.co.y / diameter + 0.5)
    d = obj_from_bm(f"rotor_{idx}_blur", bm, m["prop_blur"], r, (0, 0, 0.001))
    d.hide_render = True
    d.hide_set(True)
    return r


def antenna(name, parent, base, tilt, length=0.07, m=None):
    rot = Euler((tilt, 0, 0))
    tip = Vector(base) + rot.to_matrix() @ Vector((0, 0, length))
    parts = [cyl(name + "_coax", 0.0012, length, (Vector(base) + tip) / 2, m["black_plastic"], parent, tuple(rot), 8),
             cyl(name + "_tip", 0.006, 0.012, tip, m["tpu_black"], parent, tuple(rot), 16)]
    return join(parts, name)


def lipo(name, parent, size, loc, m):
    w, l, h = size
    pack = box(name, (w, l, h), loc, m["lipo_wrap"], parent, bev=0.003)
    label = box(name + "_label", (w + 0.0004, l * 0.62, h * 0.7), (loc[0], loc[1] + l * 0.08, loc[2]), m["lipo_label"], parent, bev=0.001)
    strap = box(name + "_strap", (w + 0.003, 0.018, h + 0.003), (loc[0], loc[1] - l * 0.05, loc[2] - 0.0015), m["strap"], parent, bev=0.001)
    leads = [cyl(name + f"_lead{i}", 0.0022, 0.04, (loc[0] + (i - 0.5) * 0.006, loc[1] - l / 2 - 0.018, loc[2]), m[c], parent, (math.pi / 2, 0, 0), 8)
             for i, c in enumerate(("silicone_red", "silicone_black"))]
    xt = box(name + "_xt60", (0.016, 0.009, 0.008), (loc[0], loc[1] - l / 2 - 0.042, loc[2]), m["xt60"], parent, bev=0.001)
    return join([pack, label, strap, xt] + leads, name)


# ----------------------------------------------------------------------------- FPV quad (5"/7"/10"/whoop)
def build_fpv(name, wheelbase, prop_d_in, pitch_in, blades=3, stator=(23, 6), battery=(0.036, 0.075, 0.037),
              prop_mat="prop_pink", bell_mat="alu_red", ducts=False, action_cam=True, cam_tilt_deg=30, gps=False,
              arm_w=0.015, arm_t=0.005, payload=False):
    CUR["col"] = collection(name)
    m = M()
    root = empty(name + "_root")
    root["drone_id"] = name
    a = wheelbase / 2 / math.sqrt(2)  # motor x/y offset for true-X
    pos = [(a, -a), (a, a), (-a, -a), (-a, a)]  # BF order: RR, FR, RL, FL
    cw = [True, False, False, True]  # props-in
    frame = []
    # --- arms (tapered, rounded motor pads) - outline in arm-local coords along +X
    L = wheelbase / 2
    pad = stator[0] / 1000 / 2 + 0.006
    arm_pts = [(0.012, -arm_w / 2), (L - pad * 0.8, -arm_w * 0.42)]
    arm_pts += [(L + pad * math.cos(t), pad * math.sin(t)) for t in [(-math.pi / 2 + i * math.pi / 8) for i in range(9)]]
    arm_pts += [(L - pad * 0.8, arm_w * 0.42), (0.012, arm_w / 2)]
    for i, (px, py) in enumerate(pos):
        ang = math.atan2(py, px)
        o = extrude_outline(f"{name}_arm{i}", arm_pts, arm_t, 0.0, m["carbon"], root)
        o.rotation_euler = (0, 0, ang)
        frame.append(o)
    # --- plates / standoffs / stack
    body_w, body_l = 0.038, wheelbase * 0.44
    frame.append(extrude_outline(name + "_bottom_plate", rounded_rect(body_w, body_l, 0.006), 0.002, -0.002, m["carbon"], root))
    st_h = 0.028 if wheelbase < 0.3 else 0.032
    top_z = arm_t + st_h
    frame.append(extrude_outline(name + "_top_plate", rounded_rect(body_w - 0.004, body_l * 0.92, 0.006), 0.002, top_z, m["carbon"], root))
    for sx in (-1, 1):
        for sy in (-1, 1):
            frame.append(cyl(f"{name}_standoff{sx}{sy}", 0.0025, st_h, (sx * 0.0152, sy * body_l * 0.36, arm_t + st_h / 2), m[bell_mat], root, seg=10))
    for k, z in enumerate((arm_t + 0.006, arm_t + 0.014)):
        frame.append(box(f"{name}_stack{k}", (0.036, 0.036, 0.0016), (0, -0.004, z), m["pcb"], root, bev=0.0003))
        frame.append(box(f"{name}_stack{k}_chip", (0.012, 0.012, 0.0015), (0.004, -0.004, z + 0.0015), m["chip"], root, bev=0))
        frame.append(box(f"{name}_stack{k}_caps", (0.006, 0.02, 0.004), (-0.011, -0.004, z + 0.0028), m["chip"], root, bev=0.0005))
    frame.append(box(name + "_grip", (body_w - 0.006, body_l * 0.8, 0.0015), (0, 0, top_z + 0.0028), m["grip"], root, bev=0))
    # --- FPV camera in TPU side plates, uptilted
    cam_y = body_l / 2 - 0.006
    cam_z = arm_t + st_h * 0.55
    tilt = math.radians(cam_tilt_deg)
    for sx in (-1, 1):
        frame.append(box(f"{name}_cam_side{sx}", (0.0025, 0.026, 0.024), (sx * 0.0135, cam_y - 0.004, cam_z), m["tpu_orange"], root, bev=0.001))
    cam = box(name + "_fpv_cam_body", (0.019, 0.017, 0.019), (0, cam_y, cam_z), m["black_plastic"], root, (-tilt, 0, 0), 0.0015)
    lens = cyl(name + "_fpv_cam_lens", 0.0068, 0.012, (0, 0, 0), m["lens_ring"], root, seg=20)
    lens.location = Vector((0, cam_y, cam_z)) + Euler((-tilt, 0, 0)).to_matrix() @ Vector((0, 0.014, 0))
    lens.rotation_euler = (math.pi / 2 - tilt, 0, 0)
    glass = cyl(name + "_fpv_cam_glass", 0.0052, 0.002, (0, 0, 0), m["glass"], root, seg=20)
    glass.location = Vector((0, cam_y, cam_z)) + Euler((-tilt, 0, 0)).to_matrix() @ Vector((0, 0.0205, 0))
    glass.rotation_euler = lens.rotation_euler
    frame += [cam, lens, glass]
    eye = empty("fpv_cam", root, tuple(glass.location), (math.pi / 2 - tilt, 0, 0))
    eye["uptilt_deg"] = cam_tilt_deg
    eye["fov_deg_h"] = 150
    # --- digital VTX/air unit with fins at rear + antennas
    vtx_y = -body_l * 0.28
    frame.append(box(name + "_vtx", (0.03, 0.03, 0.012), (0, vtx_y, arm_t + st_h - 0.009), m["alu_gray"], root, bev=0.001))
    for k in range(5):
        frame.append(box(f"{name}_vtx_fin{k}", (0.028, 0.0012, 0.004), (0, vtx_y - 0.012 + k * 0.006, arm_t + st_h - 0.001), m["alu_gray"], root, bev=0))
    frame.append(antenna(name + "_ant_l", root, (-0.012, -body_l / 2 + 0.002, top_z), -2.4, 0.06, m))
    frame.append(antenna(name + "_ant_r", root, (0.012, -body_l / 2 + 0.002, top_z), -2.4, 0.06, m))
    frame.append(box(name + "_ant_mount", (0.034, 0.012, 0.01), (0, -body_l / 2 + 0.002, top_z + 0.002), m["tpu_orange"], root, bev=0.002))
    frame.append(cyl(name + "_rx_ant", 0.0006, 0.05, (0.016, -body_l / 2 - 0.012, arm_t + 0.006), m["black_plastic"], root, (0, math.pi / 2, 0.6), 6))
    frame.append(box(name + "_led_bar", (0.026, 0.004, 0.003), (0, -body_l / 2 - 0.004, arm_t + 0.002), m["led_red"], root, bev=0))
    if gps:
        frame.append(box(name + "_gps", (0.022, 0.022, 0.008), (0, -body_l * 0.36, top_z + 0.016), m["black_plastic"], root, bev=0.001))
    # --- battery on top + optional action camera
    bw, bl, bh = battery
    frame.append(lipo(name + "_lipo", root, battery, (0, -0.004, top_z + 0.0035 + bh / 2), m))
    if action_cam:
        gz = top_z + 0.0035 + bh + 0.022
        gp = box(name + "_action_cam", (0.062, 0.033, 0.044), (0, 0.004, gz), m["black_plastic"], root, (-math.radians(20), 0, 0), 0.003)
        gl = cyl(name + "_action_cam_lens", 0.009, 0.006, (0.016, 0.004 + 0.019, gz + 0.006), m["glass"], root, (math.pi / 2 - math.radians(20), 0, 0), 20)
        frame += [gp, gl, box(name + "_action_mount", (0.03, 0.03, 0.02), (0, 0.004, gz - 0.026), m["tpu_black"], root, bev=0.002)]
    if payload:  # generic drop payload box under the frame (heavy-lift / delivery training)
        frame.append(box(name + "_payload", (0.05, 0.12, 0.05), (0, 0, -0.03), m["olive"], root, bev=0.004))
    # --- motors, ducts, props
    motor_top = 0
    for i, (px, py) in enumerate(pos):
        mot, motor_top = make_motor(f"{name}_motor{i}", root, stator[0], stator[1], m[bell_mat], m)
        mot.location = (px, py, arm_t)
        if ducts:
            R = prop_d_in * 0.0254 / 2 + 0.003
            prof = [(R, -0.004), (R + 0.003, -0.002), (R + 0.0045, 0.008), (R + 0.004, 0.022), (R + 0.001, 0.024), (R, 0.02), (R - 0.0015, 0.008)]
            frame.append(lathe(f"{name}_duct{i}", prof, m["black_plastic"], root, (px, py, arm_t - 0.002)))
    for i, (px, py) in enumerate(pos):
        make_rotor(i, root, (px, py), cw[i], prop_d_in * 0.0254, pitch_in, blades, m[prop_mat], arm_t + motor_top, m=m)
    join(frame, name + "_frame")
    return root


# ----------------------------------------------------------------------------- consumer folding camera drone (Mavic-class, brand-neutral)
def build_camera_drone(name="camera_drone_fold"):
    CUR["col"] = collection(name)
    m = M()
    root = empty(name + "_root")
    root["drone_id"] = name
    parts = []
    # fuselage: lofted rounded body from cross sections
    bm = bmesh.new()
    secs = [(-0.105, 0.03, 0.022, 0.0), (-0.08, 0.044, 0.034, 0.002), (-0.02, 0.05, 0.04, 0.004), (0.04, 0.048, 0.038, 0.002),
            (0.085, 0.04, 0.03, -0.004), (0.11, 0.026, 0.02, -0.008)]
    rings = []
    for y, hw, hh, zc in secs:
        ring = []
        for k in range(24):
            t = k / 24 * math.tau
            c, s = math.cos(t), math.sin(t)
            ex = 4.0
            x = hw * math.copysign(abs(c) ** (2 / ex), c)
            z = hh * math.copysign(abs(s) ** (2 / ex), s) + zc
            ring.append(bm.verts.new((x, y, z)))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for k in range(24):
            bm.faces.new((rings[i][k], rings[i][(k + 1) % 24], rings[i + 1][(k + 1) % 24], rings[i + 1][k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    body = obj_from_bm(name + "_body", bm, m["drone_gray"], root, smooth=True)
    sub = body.modifiers.new("sub", "SUBSURF"); sub.levels = 1
    parts.append(body)
    parts.append(box(name + "_top_panel", (0.06, 0.12, 0.004), (0, -0.01, 0.042), m["drone_dark"], root, bev=0.002))
    parts.append(box(name + "_battery", (0.07, 0.11, 0.03), (0, -0.03, 0.03), m["drone_dark"], root, bev=0.006))
    for sx in (-1, 1):  # obstacle sensors
        parts.append(cyl(f"{name}_sensor_f{sx}", 0.005, 0.004, (sx * 0.018, 0.108, 0.006), m["glass"], root, (math.pi / 2, 0, 0), 16))
        parts.append(cyl(f"{name}_sensor_d{sx}", 0.005, 0.004, (sx * 0.015, 0.03, -0.042), m["glass"], root, (0, 0, 0), 16))
    # gimbal + camera
    parts.append(box(name + "_gimbal_yoke", (0.044, 0.012, 0.03), (0, 0.112, -0.012), m["drone_dark"], root, bev=0.003))
    cam = box(name + "_camera", (0.036, 0.034, 0.032), (0, 0.126, -0.02), m["drone_dark"], root, bev=0.006)
    lens = cyl(name + "_camera_lens", 0.012, 0.012, (0, 0.146, -0.02), m["glass"], root, (math.pi / 2, 0, 0), 28)
    parts += [cam, lens]
    empty("fpv_cam", root, (0, 0.152, -0.02), (math.pi / 2, 0, 0))["fov_deg_h"] = 84
    # folding arms: front arms swing up-forward, rear arms lower-back (real Mavic layout)
    arm_pos = [((0.155, -0.12), -0.012, True), ((0.15, 0.11), 0.022, False), ((-0.155, -0.12), -0.012, False), ((-0.15, 0.11), 0.022, True)]
    for i, ((mx, my), mz, cwi) in enumerate(arm_pos):
        root_pt = Vector((math.copysign(0.04, mx), 0.06 if my > 0 else -0.07, mz))
        tip = Vector((mx, my, mz + 0.004))
        d = tip - root_pt
        arm = box(f"{name}_arm{i}", (0.014, d.length, 0.011), (root_pt + tip) / 2, m["drone_gray"], root, (0, 0, -math.atan2(d.x, d.y)), 0.004)
        pod = cyl(f"{name}_motor_pod{i}", 0.014, 0.02, tip + Vector((0, 0, 0.004)), m["drone_dark"], root, seg=24, bev=0.002)
        parts += [arm, pod]
        if my < 0:  # rear arms have landing feet
            parts.append(box(f"{name}_foot{i}", (0.008, 0.01, 0.03), tip + Vector((0, 0, -0.016)), m["drone_dark"], root, bev=0.002))
        else:
            parts.append(box(f"{name}_led{i}", (0.006, 0.004, 0.003), tip + Vector((0, 0.014, -0.004)), m["led_green" if mx > 0 else "led_red"], root, bev=0))
        make_rotor(i, root, (mx, my), cwi, 0.2388, 5.0, 2, m["prop_gray"], mz + 0.016, nut=False, m=m)
    join(parts, name + "_frame")
    return root


# ----------------------------------------------------------------------------- delta-wing loitering munition (Shahed-136 class airframe, inert)
def build_delta_lm(name="delta_wing_lm"):
    """Approx. public dimensions: length 3.5 m, span 2.5 m, ~200 kg, pusher 2-blade prop, tip fins. No internals."""
    CUR["col"] = collection(name)
    m = M()
    root = empty(name + "_root")
    root["drone_id"] = name
    parts = []
    # fuselage: lathe along Y (built along Z, rotated)
    prof = [(0.0, 1.75), (0.06, 1.70), (0.13, 1.58), (0.18, 1.40), (0.2, 1.1), (0.2, -0.9), (0.19, -1.25), (0.16, -1.45),
            (0.12, -1.55), (0.0, -1.56)]
    fus = lathe(name + "_fuselage", [(r, z) for r, z in prof], m["camo_gray"], root, rot=(-math.pi / 2, 0, 0), seg=32)
    parts.append(fus)
    # cropped delta wing: root chord along fuselage, tip chord small
    def wing(side):
        s = side
        le_root, te_root, span, le_tip, te_tip = 0.95, -1.5, 1.25, -1.05, -1.5
        pts = [(s * 0.18, le_root), (s * span, le_tip), (s * span, te_tip), (s * 0.18, te_root)]
        if s < 0:
            pts = list(reversed(pts))
        bm = bmesh.new()
        top = [bm.verts.new((x, y, 0.035)) for x, y in pts]
        bot = [bm.verts.new((x, y, -0.035)) for x, y in pts]
        bm.faces.new(top)
        bm.faces.new(list(reversed(bot)))
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((bot[i], bot[j], top[j], top[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        w = obj_from_bm(f"{name}_wing{'L' if s < 0 else 'R'}", bm, m["camo_gray"], root, loc=(0, 0, -0.02))
        bevel(w, 0.02, 3, 30)
        # vertical tip fin (winglet) above and below
        fin = [(s * span, -0.75), (s * span, -1.5), (s * span, -1.5), (s * span, -0.95)]
        bm2 = bmesh.new()
        vs = [bm2.verts.new(v) for v in [(s * span, -0.9, 0.0), (s * span, -1.5, 0.0), (s * span, -1.55, 0.42), (s * span, -1.3, 0.42)]]
        vs2 = [bm2.verts.new(v) for v in [(s * span, -1.0, 0.0), (s * span, -1.5, 0.0), (s * span, -1.52, -0.2), (s * span, -1.32, -0.2)]]
        for q in (vs, vs2):
            bm2.faces.new(q)
        f = obj_from_bm(f"{name}_fin{'L' if s < 0 else 'R'}", bm2, m["camo_gray"], root)
        sol = f.modifiers.new("sol", "SOLIDIFY"); sol.thickness = 0.02
        return [w, f]
    parts += wing(1) + wing(-1)
    # elevons (separate nodes so the game can deflect them; hinge along trailing edge)
    for s in (1, -1):
        hinge = empty(f"elevon_{'R' if s > 0 else 'L'}", root, (s * 0.7, -1.38, -0.02))
        hinge["axis"] = "x"
        box(f"{name}_elevon_{'R' if s > 0 else 'L'}_surf", (0.9, 0.18, 0.03), (0, -0.09, 0), m["olive"], hinge, bev=0.006)
    # engine cowling + pusher prop
    parts.append(cyl(name + "_engine", 0.14, 0.25, (0, -1.62, 0.0), m["foam_black"], root, (math.pi / 2, 0, 0), 24, r2=0.11))
    parts.append(box(name + "_exhaust", (0.03, 0.12, 0.03), (0.12, -1.55, -0.12), m["steel"], root, bev=0.006))
    rot = make_rotor(0, root, (0, 0), True, 0.76, 14.0, 2, m["wood_prop"], 0, nut=False, m=m)
    rot.location = (0, -1.79, 0)
    rot.rotation_euler = (-math.pi / 2, 0, 0)  # spin axis = -Y (pusher)
    for k in (1, -1):
        parts.append(box(f"{name}_antenna{k}", (0.01, 0.06, 0.12), (0.0, 0.3 + k * 0.4, 0.24), m["foam_black"], root, bev=0.004))
    empty("fpv_cam", root, (0, 1.6, -0.05), (math.pi / 2 - math.radians(10), 0, 0))["fov_deg_h"] = 60
    join(parts, name + "_airframe")
    return root


# ----------------------------------------------------------------------------- export / build all
def export_glb(root, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in [root] + list(root.children_recursive):
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = root
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=True, export_extras=True, export_image_format="AUTO")
    for o in root.children_recursive:
        if o.name.endswith("_blur"):
            o.hide_set(True)


SPECS = {
    # name: kwargs for build_fpv  (real-world reference builds)
    "fpv_5in_freestyle": dict(wheelbase=0.225, prop_d_in=5.1, pitch_in=3.6, blades=3, stator=(23, 6),
                              battery=(0.035, 0.075, 0.038), prop_mat="prop_pink", bell_mat="alu_red", action_cam=True),
    "fpv_5in_racer": dict(wheelbase=0.215, prop_d_in=5.1, pitch_in=4.3, blades=3, stator=(22, 7), battery=(0.033, 0.07, 0.034),
                          prop_mat="prop_cyan", bell_mat="alu_purple", action_cam=False, cam_tilt_deg=45, arm_w=0.013, arm_t=0.006),
    "fpv_7in_longrange": dict(wheelbase=0.295, prop_d_in=7.0, pitch_in=3.5, blades=2, stator=(28, 6), battery=(0.045, 0.09, 0.05),
                              prop_mat="prop_gray", bell_mat="alu_gray", action_cam=False, cam_tilt_deg=20, gps=True, arm_w=0.018, arm_t=0.006),
    "fpv_10in_heavy": dict(wheelbase=0.42, prop_d_in=10.0, pitch_in=5.0, blades=3, stator=(32, 8), battery=(0.06, 0.13, 0.06),
                           prop_mat="prop_gray", bell_mat="alu_gray", action_cam=False, cam_tilt_deg=15, gps=True, arm_w=0.022,
                           arm_t=0.008, payload=True),
    "cinewhoop_3in": dict(wheelbase=0.142, prop_d_in=3.0, pitch_in=2.5, blades=5, stator=(15, 6), battery=(0.03, 0.06, 0.03),
                          prop_mat="prop_gray", bell_mat="alu_gray", ducts=True, action_cam=True, cam_tilt_deg=10, arm_w=0.012, arm_t=0.003),
}


def build_all(export_dir=r"D:/DroneSim/assets/models/drones", only=None):
    out = {}
    for n, kw in SPECS.items():
        if only and n not in only:
            continue
        out[n] = build_fpv(n, **kw)
    if not only or "camera_drone_fold" in only:
        out["camera_drone_fold"] = build_camera_drone()
    if not only or "delta_wing_lm" in only:
        out["delta_wing_lm"] = build_delta_lm()
    if export_dir:
        for n, r in out.items():
            export_glb(r, os.path.join(export_dir, n + ".glb"))
    return out
