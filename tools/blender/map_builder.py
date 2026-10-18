"""Procedural, deterministic DroneSim maps (Blender 4.5+/5.x). Real-world scale, metres.

Each map produces:
  assets/maps/<id>/<id>.glb      static geometry, one mesh per material, world-space box UVs (no embedded images:
                                  the game binds PBR sets from assets/textures/<tex>/ by material custom props)
  assets/maps/<id>/<id>.json     layout: spawns, race gates, prop instances, lights/HDRI/fog, colliders
                                  (oriented boxes / cylinders / heightfield) - all in GAME space (Y-up, -Z forward)
  docs/previews/map_<id>.png     (when render=True)

Material naming:  M_<polyhaven_texture_id>  (custom props: tex, tile_m)   or  C_<name> (flat colour / emissive).
Usage inside Blender:
    exec(open(r"D:/DroneSim/tools/blender/map_builder.py", encoding="utf-8").read())
    build_maps(["training_field", "abandoned_factory", "ruined_district", "parking_garage"], preview_props=True)
"""
import json, math, os, random
import bpy, bmesh
from mathutils import Euler, Matrix, Quaternion, Vector

ROOT = r"D:/DroneSim"
TEX = ROOT + "/assets/textures"
PROPS = ROOT + "/assets/props"
CONV = Matrix.Rotation(-math.pi / 2, 4, "X")  # Blender Z-up -> game Y-up


def gpos(v):
    return [round(v[0], 3), round(v[2], 3), round(-v[1], 3)]


def gquat(rot_euler):
    q = (CONV @ Euler(rot_euler).to_matrix().to_4x4() @ CONV.inverted()).to_quaternion()
    return [round(q.x, 5), round(q.y, 5), round(q.z, 5), round(q.w, 5)]


# ----------------------------------------------------------------------------- materials
def tex_material(tex, tile=2.0):
    name = "M_" + tex
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m["tex"], m["tile_m"] = tex, tile
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    base = f"{TEX}/{tex}/{tex}"
    def img(suffix, noncolor):
        p = f"{base}_{suffix}_2k.jpg"
        if not os.path.exists(p):
            return None
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bpy.data.images.load(p, check_existing=True)
        if noncolor:
            n.image.colorspace_settings.name = "Non-Color"
        return n
    d = img("diff", False)
    if d:
        nt.links.new(d.outputs["Color"], b.inputs["Base Color"])
    nm = img("nor_gl", True)
    if nm:
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(nm.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], b.inputs["Normal"])
    arm = img("arm", True)
    if arm:
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(arm.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], b.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], b.inputs["Metallic"])
    return m


def col_material(name, rgb, emit=0.0, rough=0.5, metal=0.0):
    nm = "C_" + name
    m = bpy.data.materials.get(nm)
    if m:
        return m
    m = bpy.data.materials.new(nm)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emit
    m["color"] = list(rgb)
    m["emissive"] = emit
    return m


# ----------------------------------------------------------------------------- geometry accumulator
class Map:
    def __init__(self, mid, title, seed=1):
        self.id, self.title = mid, title
        self.rng = random.Random(seed)
        self.bms = {}
        self.colliders, self.props, self.gates, self.spawns, self.lights, self.zones = [], [], [], [], [], []
        self.terrain = None
        self.env = {}

    # -- low level
    def _bm(self, mat):
        if mat.name not in self.bms:
            bm = bmesh.new()
            bm.loops.layers.uv.new("UVMap")
            self.bms[mat.name] = (bm, mat)
        return self.bms[mat.name][0]

    def faces(self, mat, verts, faces, tile=None):
        tile = tile or mat.get("tile_m", 2.0)
        bm = self._bm(mat)
        uv = bm.loops.layers.uv.active
        vs = [bm.verts.new(v) for v in verts]
        for f in faces:
            try:
                face = bm.faces.new([vs[i] for i in f])
            except ValueError:
                continue
            face.normal_update()
            n = face.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for l in face.loops:
                c = l.vert.co
                u, v = ((c.y, c.z) if ax == 0 else (c.x, c.z) if ax == 1 else (c.x, c.y))
                if ax == 0 and n.x < 0 or ax == 1 and n.y > 0:
                    u = -u
                l[uv].uv = (u / tile, v / tile)

    # -- primitives (centre, size) ; rot = euler radians
    def box(self, c, s, mat, rot=(0, 0, 0), collide=True):
        R = Euler(rot).to_matrix()
        hx, hy, hz = s[0] / 2, s[1] / 2, s[2] / 2
        cs = [Vector((x, y, z)) for x in (-hx, hx) for y in (-hy, hy) for z in (-hz, hz)]
        vs = [Vector(c) + R @ p for p in cs]
        fs = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        self.faces(mat, vs, fs)
        if collide:
            self.colliders.append({"type": "box", "c": gpos(c), "half": [round(hx, 3), round(hz, 3), round(hy, 3)],
                                   "q": gquat(rot)})

    def cyl(self, c, r, h, mat, seg=16, collide=True, r2=None, rot=(0, 0, 0)):
        r2 = r if r2 is None else r2
        R = Euler(rot).to_matrix()
        vs = []
        for z, rr in ((-h / 2, r), (h / 2, r2)):
            for i in range(seg):
                a = i / seg * math.tau
                vs.append(Vector(c) + R @ Vector((math.cos(a) * rr, math.sin(a) * rr, z)))
        fs = [(i, (i + 1) % seg, seg + (i + 1) % seg, seg + i) for i in range(seg)]
        fs += [tuple(reversed(range(seg))), tuple(range(seg, 2 * seg))]
        self.faces(mat, vs, fs)
        if collide:
            self.colliders.append({"type": "cylinder", "c": gpos(c), "r": round(max(r, r2), 3), "h": round(h, 3), "q": gquat(rot)})

    def terrain_grid(self, size, res, hfn, mat):
        n = res + 1
        vs, fs, hs = [], [], []
        for j in range(n):
            for i in range(n):
                x, y = -size / 2 + size * i / res, -size / 2 + size * j / res
                z = hfn(x, y)
                hs.append(round(z, 3))
                vs.append(Vector((x, y, z)))
        for j in range(res):
            for i in range(res):
                a = j * n + i
                fs.append((a, a + 1, a + n + 1, a + n))
        self.faces(mat, vs, fs)
        # heightfield in game space: rows along game +Z (= -Blender Y) -> store Blender rows, document orientation
        self.terrain = {"type": "heightfield", "size": size, "res": res, "heights_rowmajor_blenderY": hs,
                        "note": "heights[j*(res+1)+i] at blender (x=-size/2+size*i/res, y=-size/2+size*j/res); game z = -y"}

    # -- higher level building blocks
    def wall(self, a, b, z0, h, t, mat, bay=4.0, win=None, damage=0.0, door=None, collide=True):
        """Wall from 2D point a to b. win=(width, height, sill). door=list of bay indices that are full openings."""
        a, b = Vector((a[0], a[1], 0)), Vector((b[0], b[1], 0))
        d = b - a
        L = d.length
        yaw = math.atan2(d.y, d.x)
        u = d.normalized()
        nb = max(1, round(L / bay))
        bw = L / nb
        def piece(u0, u1, zz0, zz1):
            if u1 - u0 < 0.05 or zz1 - zz0 < 0.05:
                return
            cc = a + u * ((u0 + u1) / 2)
            self.box((cc.x, cc.y, (zz0 + zz1) / 2), (u1 - u0, t, zz1 - zz0), mat, (0, 0, yaw), collide)
        for k in range(nb):
            u0, u1 = k * bw, (k + 1) * bw
            if door and k in door:
                piece(u0, u1, z0 + min(h, 6.0), z0 + h)
                continue
            if self.rng.random() < damage * 0.35:  # breach: whole bay missing except a ragged top
                piece(u0, u1, z0 + h - self.rng.uniform(0.2, 1.0), z0 + h)
                continue
            if win:
                ww, wh, sill = win
                m = (bw - ww) / 2
                piece(u0, u0 + m, z0, z0 + h)
                piece(u1 - m, u1, z0, z0 + h)
                if self.rng.random() > damage * 0.5:
                    piece(u0 + m, u1 - m, z0, z0 + sill)
                piece(u0 + m, u1 - m, z0 + sill + wh, z0 + h)
            else:
                piece(u0, u1, z0, z0 + h)

    def slab(self, x0, y0, x1, y1, z, t, mat, hole_p=0.0, tile=4.0, keep=None):
        nx, ny = max(1, round((x1 - x0) / tile)), max(1, round((y1 - y0) / tile))
        sx, sy = (x1 - x0) / nx, (y1 - y0) / ny
        for i in range(nx):
            for j in range(ny):
                if hole_p and self.rng.random() < hole_p and not (keep and keep(i, j)):
                    if self.rng.random() < 0.5:  # collapsed slab hanging at an angle
                        self.box((x0 + (i + 0.5) * sx, y0 + (j + 0.5) * sy, z - 1.2), (sx * 0.95, sy * 0.95, t), mat,
                                 (self.rng.uniform(-0.5, 0.5), self.rng.uniform(-0.5, 0.5), 0))
                    continue
                self.box((x0 + (i + 0.5) * sx, y0 + (j + 0.5) * sy, z - t / 2), (sx, sy, t), mat)

    def columns(self, x0, y0, x1, y1, z0, h, sz, mat, step=6.0, skip_p=0.0):
        nx, ny = max(1, round((x1 - x0) / step)), max(1, round((y1 - y0) / step))
        for i in range(nx + 1):
            for j in range(ny + 1):
                if skip_p and self.rng.random() < skip_p:
                    continue
                self.box((x0 + (x1 - x0) * i / nx, y0 + (y1 - y0) * j / ny, z0 + h / 2), (sz, sz, h), mat)

    def railing(self, a, b, z, mat, h=1.1):
        a, b = Vector(a), Vector(b)
        d = b - a
        n = max(1, int(d.length / 1.5))
        yaw = math.atan2(d.y, d.x)
        self.box(((a + b) / 2).to_tuple()[:2] + (z + h,), (d.length, 0.05, 0.05), mat, (0, 0, yaw))
        self.box(((a + b) / 2).to_tuple()[:2] + (z + h / 2,), (d.length, 0.04, 0.04), mat, (0, 0, yaw), collide=False)
        for k in range(n + 1):
            p = a + d * (k / n)
            self.box((p.x, p.y, z + h / 2), (0.05, 0.05, h), mat, collide=False)

    def stairs(self, x, y, z0, z1, w, yaw, mat, run=None):
        steps = max(2, int((z1 - z0) / 0.18))
        run = run or (z1 - z0) * 1.6
        R = Matrix.Rotation(yaw, 3, "Z")
        for k in range(steps):
            p = Vector((x, y, 0)) + R @ Vector((run * (k + 0.5) / steps, 0, 0))
            self.box((p.x, p.y, z0 + (z1 - z0) * (k + 0.5) / steps), (run / steps, w, (z1 - z0) / steps), mat, (0, 0, yaw), collide=False)
        ang = math.atan2(z1 - z0, run)
        p = Vector((x, y, 0)) + R @ Vector((run / 2, 0, 0))
        self.colliders.append({"type": "box", "c": gpos((p.x, p.y, (z0 + z1) / 2)), "half": [round(math.hypot(run, z1 - z0) / 2, 3), 0.1, w / 2],
                               "q": gquat((0, -ang, yaw))})

    def gate(self, c, yaw, w=1.6, h=1.6, z_off=0.0, style="square", mat=None):
        """FPV race gate (MultiGP-like 5ft inner). Trigger plane recorded in self.gates (order = race order)."""
        mat = mat or col_material("gate_orange", (1.0, 0.35, 0.02), rough=0.6)
        black = col_material("gate_black", (0.03, 0.03, 0.03), rough=0.7)
        t = 0.12
        cx, cy, cz = c[0], c[1], c[2] + z_off
        R = Matrix.Rotation(yaw, 3, "Z")
        def at(lx, lz):
            p = Vector((cx, cy, 0)) + R @ Vector((lx, 0, 0))
            return (p.x, p.y, cz + lz)
        self.box(at(0, h + t / 2), (w + 2 * t, t, t), mat, (0, 0, yaw))
        self.box(at(-(w + t) / 2, h / 2), (t, t, h), mat, (0, 0, yaw))
        self.box(at((w + t) / 2, h / 2), (t, t, h), mat, (0, 0, yaw))
        for sx in (-1, 1):  # sandbag feet
            self.box(at(sx * (w + t) / 2, 0.08), (0.35, 0.5, 0.16), black, (0, 0, yaw), collide=False)
        if cz > 0.3:
            self.box(at(0, -0.06), (w + 2 * t, t, t), mat, (0, 0, yaw))
        self.gates.append({"c": gpos((cx, cy, cz + h / 2)), "q": gquat((0, 0, yaw)), "w": w, "h": h,
                           "forward": gpos(R @ Vector((0, 1, 0)))})

    def flag(self, c, yaw):
        pole = col_material("flag_pole", (0.08, 0.08, 0.08), rough=0.4, metal=0.8)
        cloth = col_material("flag_cloth", (0.05, 0.6, 1.0), rough=0.8)
        self.cyl((c[0], c[1], 1.6), 0.025, 3.2, pole, 8)
        R = Matrix.Rotation(yaw, 3, "Z")
        p = Vector((c[0], c[1], 0)) + R @ Vector((0.3, 0, 0))
        self.box((p.x, p.y, 2.4), (0.6, 0.02, 1.4), cloth, (0, 0, yaw), collide=False)

    def tree(self, c, h):
        bark = tex_material("bark_brown_02") if os.path.isdir(f"{TEX}/bark_brown_02") else col_material("bark", (0.2, 0.13, 0.08), rough=0.9)
        leaves = col_material("pine_needles", (0.07, 0.16, 0.06), rough=0.9)
        self.cyl((c[0], c[1], c[2] + h * 0.2), h * 0.025, h * 0.4, bark, 6, collide=True)
        for k in range(3):
            z = c[2] + h * (0.3 + 0.22 * k)
            r = h * (0.24 - 0.06 * k)
            self.cyl((c[0], c[1], z + h * 0.15), r, h * 0.32, leaves, 7, collide=(k == 0), r2=0.01)

    def prop(self, asset, c, yaw=0.0, scale=1.0, collide="auto"):
        self.props.append({"asset": asset, "pos": gpos(c), "q": gquat((0, 0, yaw)), "scale": scale, "collide": collide})

    def spawn(self, c, yaw=0.0, kind="ground"):
        self.spawns.append({"pos": gpos(c), "q": gquat((0, 0, yaw)), "kind": kind})

    # -- output
    def finalize(self, preview_props=False, export=True, render=False):
        colname = "MAP_" + self.id
        col = bpy.data.collections.get(colname)
        if col:
            for o in list(col.all_objects):
                bpy.data.objects.remove(o, do_unlink=True)
        else:
            col = bpy.data.collections.new(colname)
            bpy.context.scene.collection.children.link(col)
        objs = []
        for name, (bm, mat) in self.bms.items():
            me = bpy.data.meshes.new(f"{self.id}_{name}")
            bm.to_mesh(me)
            bm.free()
            me.materials.append(mat)
            o = bpy.data.objects.new(f"{self.id}__{name}", me)
            col.objects.link(o)
            objs.append(o)
        self.bms = {}
        if preview_props:
            place_prop_instances(self, col)
        out_dir = f"{ROOT}/assets/maps/{self.id}"
        os.makedirs(out_dir, exist_ok=True)
        if export:
            bpy.ops.object.select_all(action="DESELECT")
            for o in objs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            bpy.ops.export_scene.gltf(filepath=f"{out_dir}/{self.id}.glb", export_format="GLB", use_selection=True,
                                      export_yup=True, export_apply=True, export_extras=True, export_image_format="NONE",
                                      export_materials="EXPORT")
        layout = {"id": self.id, "title": self.title, "units": "meters", "space": "game: +Y up, -Z forward (glTF)",
                  "geometry": f"{self.id}.glb", "env": self.env, "spawns": self.spawns, "gates": self.gates,
                  "props": self.props, "lights": self.lights, "zones": self.zones, "colliders": self.colliders,
                  "terrain": self.terrain,
                  "materials": {m.name: {"tex": m.get("tex"), "tile_m": m.get("tile_m"), "color": list(m.get("color", [])) or None,
                                         "emissive": m.get("emissive", 0)} for m in {o.data.materials[0] for o in objs}}}
        with open(f"{out_dir}/{self.id}.json", "w", encoding="utf-8") as f:
            json.dump(layout, f, ensure_ascii=False, separators=(",", ":"))
        stats = {"objects": len(objs), "faces": sum(len(o.data.polygons) for o in objs), "colliders": len(self.colliders),
                 "props": len(self.props), "gates": len(self.gates)}
        print("MAP", self.id, stats)
        return col, stats


PROP_LIB = {}


def place_prop_instances(mp, col):
    """Editor preview only: show Poly Haven props as collection instances (not exported into the map GLB)."""
    libroot = bpy.data.collections.get("PROP_LIBRARY")
    if not libroot:
        libroot = bpy.data.collections.new("PROP_LIBRARY")
        bpy.context.scene.collection.children.link(libroot)
    for lc in bpy.context.view_layer.layer_collection.children:
        if lc.name == "PROP_LIBRARY":
            lc.exclude = True
    for p in mp.props:
        a = p["asset"]
        if a not in PROP_LIB:
            path = f"{PROPS}/{a}/{a}.gltf"
            if not os.path.exists(path):
                PROP_LIB[a] = None
                continue
            before = set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=path)
            new = [o for o in bpy.data.objects if o not in before]
            c = bpy.data.collections.new("LIB_" + a)
            libroot.children.link(c)
            for o in new:
                for uc in list(o.users_collection):
                    uc.objects.unlink(o)
                c.objects.link(o)
            PROP_LIB[a] = c
        lib = PROP_LIB[a]
        if lib is None:
            continue
        e = bpy.data.objects.new("prop_" + a, None)
        e.instance_type = "COLLECTION"
        e.instance_collection = lib
        x, y, z = p["pos"]
        e.location = (x, -z, y)
        q = Quaternion((p["q"][3], p["q"][0], p["q"][1], p["q"][2]))
        e.rotation_euler = (CONV.inverted() @ q.to_matrix().to_4x4() @ CONV).to_euler()
        e.scale = (p["scale"],) * 3
        col.objects.link(e)


# ============================================================================= MAPS
def map_training_field():
    mp = Map("training_field", "Полигон", seed=11)
    mp.env = {"hdri": "kloofendal_48d_partly_cloudy_puresky_4k.hdr", "sun": {"dir": gpos((0.4, -0.5, -0.75)), "intensity": 3.2},
              "fog": {"color": [0.72, 0.8, 0.9], "density": 0.0009}, "wind": {"mean_ms": 2.0, "gust_ms": 3.5, "dir_deg": 240},
              "time": "midday", "difficulty": 1, "description": "Открытое поле для обучения: взлёт/посадка, ворота, слалом, ангар."}
    grass = tex_material("acg_grass001", 4.0)
    asphalt = tex_material("asphalt_02", 4.0)
    concrete = tex_material("hangar_concrete_floor", 4.0)
    metal = tex_material("corrugated_iron_02", 2.0)
    rust = tex_material("rusty_metal_02", 2.0)
    white = col_material("paint_white", (0.9, 0.9, 0.88), rough=0.6)
    yellow = col_material("paint_yellow", (0.95, 0.75, 0.05), rough=0.6)
    orange = col_material("cone_orange", (1.0, 0.3, 0.0), rough=0.5)
    def h(x, y):
        r = max(abs(x), abs(y))
        base = 0.0 if r < 140 else ((r - 140) / 110) ** 2 * 18
        return base + 0.6 * math.sin(x * 0.031) * math.cos(y * 0.027) * min(1, r / 60)
    mp.terrain_grid(500, 100, h, grass)
    # runway + apron
    mp.box((0, -20, -0.05), (16, 180, 0.12), asphalt)
    for k in range(-8, 9):
        mp.box((0, -20 + k * 10, 0.012), (0.3, 4.5, 0.01), white, collide=False)
    mp.box((40, 40, -0.05), (50, 30, 0.12), concrete)
    # landing pads (H)
    for i, (px, py) in enumerate(((30, 40), (50, 40), (0, 80))):
        mp.cyl((px, py, 0.03), 3.0, 0.1, concrete, 24)
        mp.cyl((px, py, 0.085), 2.6, 0.01, yellow, 24, collide=False)
        mp.cyl((px, py, 0.09), 2.45, 0.01, concrete, 24, collide=False)
        mp.box((px - 0.8, py, 0.1), (0.3, 2.2, 0.01), white, collide=False)
        mp.box((px + 0.8, py, 0.1), (0.3, 2.2, 0.01), white, collide=False)
        mp.box((px, py, 0.1), (1.3, 0.3, 0.01), white, collide=False)
        mp.spawn((px, py, 0.15), 0, "pad")
    # hangar (open front) with arched roof made of segments
    hx, hy, hw, hd, hh = 75, 40, 24, 30, 8
    mp.wall((hx - hw / 2, hy + hd / 2), (hx + hw / 2, hy + hd / 2), 0, hh, 0.3, metal)
    mp.wall((hx - hw / 2, hy - hd / 2), (hx - hw / 2, hy + hd / 2), 0, hh, 0.3, metal, win=(2.5, 1.2, 4.5))
    mp.wall((hx + hw / 2, hy - hd / 2), (hx + hw / 2, hy + hd / 2), 0, hh, 0.3, metal, win=(2.5, 1.2, 4.5))
    mp.slab(hx - hw / 2, hy - hd / 2, hx + hw / 2, hy + hd / 2, 0.02, 0.15, concrete)
    for k in range(9):
        a0, a1 = math.pi * k / 9, math.pi * (k + 1) / 9
        am = (a0 + a1) / 2
        x = hx - math.cos(am) * hw / 2
        z = hh + math.sin(am) * hw * 0.25
        seg = hw / 2 * (a1 - a0) * 1.05
        mp.box((x, hy, z), (seg, hd, 0.12), metal, (0, math.atan2(math.cos(am) * 0.25, math.sin(am)) * -1, 0))
    for k in range(6):
        mp.box((hx, hy - hd / 2 + k * hd / 5, hh + 1), (hw, 0.25, 0.3), rust)
    # containers yard
    cont = [tex_material("painted_metal_shutter", 2.0), rust, metal]
    for i in range(6):
        x, y = -50 - (i % 3) * 3.0, 30 + (i // 3) * 13
        for lvl in range(1 + (i % 2)):
            mp.box((x, y, 1.3 + lvl * 2.6), (2.44, 12.2, 2.59), cont[(i + lvl) % 3], (0, 0, 0.0))
    # race course: 10 gates loop + slalom poles + cones
    path = [(-30, -40, 0), (-38, -10, 0), (-30, 20, 1.2), (-10, 35, 0), (15, 25, 2.5),
            (25, 0, 0), (15, -25, 0), (0, -50, 0), (-15, -70, 2.0), (-28, -60, 0)]
    for i, (x, y, z) in enumerate(path):
        # face the course: gate forward R(yaw) @ +Y = (-sin, cos) along the loop tangent (next - prev)
        (px, py, _), (nx, ny, _) = path[i - 1], path[(i + 1) % len(path)]
        yaw = math.atan2(-(nx - px), ny - py)
        mp.gate((x, y, 0), yaw, z_off=z)
        if z > 0:
            for sx in (-1, 1):  # elevated gate support legs
                R = Matrix.Rotation(yaw, 3, "Z")
                p = Vector((x, y, 0)) + R @ Vector((sx * 0.86, 0, 0))
                mp.box((p.x, p.y, z / 2), (0.1, 0.1, z), col_material("gate_black", (0.03, 0.03, 0.03)), (0, 0, yaw))
    for k in range(8):
        mp.flag((-60 + k * 6, -10 + (k % 2) * 3, 0), 0.0)
    for k in range(20):
        mp.cyl((60 + (k % 5) * 4, -40 - (k // 5) * 4, 0.2), 0.15, 0.4, orange, 10, r2=0.03)
    # treelines
    for k in range(140):
        a = mp.rng.uniform(0, math.tau)
        r = mp.rng.uniform(120, 230)
        x, y = math.cos(a) * r, math.sin(a) * r
        mp.tree((x, y, h(x, y)), mp.rng.uniform(9, 17))
    for k in range(25):
        x, y = mp.rng.uniform(-110, -70), mp.rng.uniform(-90, 90)
        mp.tree((x, y, h(x, y)), mp.rng.uniform(8, 14))
    # props
    for i in range(10):
        mp.prop("Barrel_01" if i % 2 else "barrel_03", (60 + i * 1.1, 52, 0), i * 0.7)
    for i in range(6):
        mp.prop("wooden_crate_01", (66 + (i % 3) * 1.3, 30 + (i // 3) * 1.3, 0), 0.1 * i)
    mp.prop("portable_generator", (85, 25, 0), 0.4)
    mp.prop("metal_tool_chest", (82, 52, 0), 3.14)
    mp.prop("plastic_monobloc_chair_01", (34, 30, 0), 2.6)
    mp.prop("wooden_picnic_table", (36, 28, 0), 0.3)
    for k in range(6):
        mp.prop("street_lamp_01", (8.5, -90 + k * 30, 0), math.pi / 2)
    mp.spawn((0, -100, 0.1), 0, "runway")
    mp.zones.append({"kind": "nofly_boundary", "radius": 240})
    return mp


def map_abandoned_factory():
    mp = Map("abandoned_factory", "Заброшенный завод", seed=7)
    mp.env = {"hdri": "industrial_sunset_puresky_4k.hdr", "sun": {"dir": gpos((-0.6, 0.3, -0.35)), "intensity": 2.6},
              "fog": {"color": [0.85, 0.72, 0.6], "density": 0.0035}, "wind": {"mean_ms": 3.0, "gust_ms": 6.0, "dir_deg": 200},
              "indoor_reverb": True, "time": "sunset", "difficulty": 3,
              "description": "Огромный цех с дырявой крышей, кран-балками и галереями; двор с трубой, цистернами и складом."}
    brick = tex_material("factory_brick", 2.5)
    conc = tex_material("concrete_wall_008", 3.0)
    floor = tex_material("concrete_floor_damaged_01", 4.0)
    yard = tex_material("gravel_concrete_03", 4.0)
    asph = tex_material("asphalt_02", 4.0)
    rust = tex_material("rusty_metal_02", 2.0)
    corr = tex_material("worn_corrugated_iron", 2.0)
    grate = tex_material("metal_grate_rusty", 1.0)
    plaster = tex_material("damaged_plaster", 3.0)
    steel = col_material("steel_beam", (0.22, 0.2, 0.18), rough=0.6, metal=0.8)
    mp.terrain_grid(600, 60, lambda x, y: 0.0 if max(abs(x), abs(y)) < 180 else ((max(abs(x), abs(y)) - 180) / 120) ** 2 * 25, yard)
    mp.box((0, -60, 0.02), (14, 300, 0.1), asph)
    # ---- main hall 96 x 36 x 14
    X0, X1, Y0, Y1, H = -48, 48, -18, 18, 14
    mp.slab(X0, Y0, X1, Y1, 0.06, 0.12, floor, tile=6)
    mp.columns(X0, Y0, X1, Y1, 0, H, 0.6, conc, step=6, skip_p=0.04)
    win = (4.0, 6.5, 5.0)
    mp.wall((X0, Y0), (X1, Y0), 0, H, 0.4, brick, bay=6, win=win, damage=0.35, door=[3, 11])
    mp.wall((X0, Y1), (X1, Y1), 0, H, 0.4, brick, bay=6, win=win, damage=0.35, door=[8])
    mp.wall((X0, Y0), (X0, Y1), 0, H, 0.4, brick, bay=6, win=win, damage=0.2, door=[2, 3])
    mp.wall((X1, Y0), (X1, Y1), 0, H, 0.4, brick, bay=6, win=win, damage=0.4, door=[2])
    # roof trusses + crane rails + roof panels with holes
    for i in range(17):
        x = X0 + i * 6
        mp.box((x, 0, H + 0.4), (0.35, Y1 - Y0, 0.6), steel)
        mp.box((x, 0, H + 2.1), (0.25, Y1 - Y0, 0.25), steel, collide=False)
        for k in range(-3, 4):
            mp.box((x, k * 4.5, H + 1.25), (0.12, 0.12, 1.7), steel, (0.5 * (1 if k % 2 else -1), 0, 0), collide=False)
    for side in (Y0 + 1.5, Y1 - 1.5):
        mp.box((0, side, 9.5), (X1 - X0, 0.5, 0.7), steel)
    crane_x = 12
    mp.box((crane_x, 0, 10.2), (1.0, Y1 - Y0 - 2, 1.1), tex_material("painted_metal_shutter", 2.0))
    mp.box((crane_x, 4, 9.2), (1.6, 1.6, 1.2), rust)
    mp.cyl((crane_x, 4, 6.5), 0.05, 4.0, steel, 6, collide=False)
    mp.slab(X0, Y0, X1, Y1, H + 2.3, 0.08, corr, hole_p=0.22, tile=6)
    # catwalk on the north side at 6 m with railing + stairs
    mp.slab(X0 + 0.4, Y1 - 2.2, X1 - 0.4, Y1 - 0.4, 6.0, 0.1, grate, tile=6)
    mp.railing((X0 + 0.4, Y1 - 2.2, 0), (X1 - 0.4, Y1 - 2.2, 0), 6.0, steel)
    for i in range(16):
        mp.box((X0 + 3 + i * 6, Y1 - 2.1, 5.7), (0.25, 0.25, 0.5), steel, collide=False)
    mp.stairs(X0 + 2, Y1 - 3.2, 0, 6.0, 1.2, 0.0, grate)
    # office mezzanine (two floors) in the east end
    mp.slab(30, Y0 + 0.4, X1 - 0.4, Y0 + 12, 4.0, 0.25, conc, hole_p=0.1, tile=4)
    mp.slab(30, Y0 + 0.4, X1 - 0.4, Y0 + 12, 8.0, 0.25, conc, hole_p=0.25, tile=4)
    mp.wall((30, Y0 + 12), (X1 - 0.4, Y0 + 12), 0, 4, 0.2, plaster, bay=3, win=(1.6, 1.4, 1.0), damage=0.4)
    mp.wall((30, Y0 + 12), (X1 - 0.4, Y0 + 12), 4, 4, 0.2, plaster, bay=3, win=(1.8, 1.6, 1.0), damage=0.5)
    mp.wall((30, Y0 + 0.4), (30, Y0 + 12), 0, 8, 0.2, plaster, bay=3, win=(1.2, 2.2, 0.0), damage=0.4)
    # machinery blocks / pits / debris
    for i in range(6):
        x = -36 + i * 11
        mp.box((x, -6, 1.2), (4.0, 2.5, 2.4), rust)
        mp.box((x + 1.2, -6, 3.0), (1.2, 1.2, 1.2), rust)
        mp.cyl((x - 1.0, -6, 3.2), 0.3, 1.6, steel, 10)
    for i in range(30):
        x, y = mp.rng.uniform(X0 + 2, X1 - 2), mp.rng.uniform(Y0 + 2, Y1 - 2)
        s = mp.rng.uniform(0.4, 1.5)
        mp.box((x, y, s * 0.3), (s, s * 0.8, s * 0.6), conc, (mp.rng.uniform(-0.3, 0.3), mp.rng.uniform(-0.3, 0.3), mp.rng.uniform(0, 3)))
    for i in range(14):
        mp.prop(["Barrel_01", "Barrel_02", "barrel_03"][i % 3], (mp.rng.uniform(-40, 25), mp.rng.uniform(4, 12), 0.06), mp.rng.uniform(0, 6))
    for i in range(8):
        mp.prop("wooden_crate_02", (-20 + i * 1.3, 10, 0.06), 0.2 * i)
    mp.prop("steel_frame_shelves_01", (40, 10, 0.06), math.pi)
    mp.prop("steel_frame_shelves_02", (42, 10, 0.06), math.pi)
    mp.prop("metal_tool_chest", (36, -10, 0.06), 1.0)
    for i in range(8):
        mp.prop("hanging_industrial_lamp", (X0 + 6 + i * 12, 0, H - 1.0), 0)
        mp.lights.append({"type": "point", "pos": gpos((X0 + 6 + i * 12, 0, H - 1.5)), "color": [1.0, 0.85, 0.6], "intensity": 0.0,
                          "range": 18, "flicker": i % 3 == 0, "note": "mostly broken; enable for night variant"})
    # ---- secondary warehouse with roller doors
    WX, WY = -10, -60
    mp.slab(WX - 20, WY - 12, WX + 20, WY + 12, 0.06, 0.12, floor, tile=6)
    mp.wall((WX - 20, WY + 12), (WX + 20, WY + 12), 0, 8, 0.3, conc, bay=5, win=(3, 1.5, 5.5), damage=0.2)
    mp.wall((WX - 20, WY - 12), (WX + 20, WY - 12), 0, 8, 0.3, conc, bay=5, door=[1, 3, 5])
    mp.wall((WX - 20, WY - 12), (WX - 20, WY + 12), 0, 8, 0.3, conc, bay=6)
    mp.wall((WX + 20, WY - 12), (WX + 20, WY + 12), 0, 8, 0.3, conc, bay=6, door=[1])
    mp.slab(WX - 20.3, WY - 12.3, WX + 20.3, WY + 12.3, 8.25, 0.25, corr, hole_p=0.15, tile=5)
    mp.columns(WX - 15, WY - 6, WX + 15, WY + 6, 0, 8, 0.4, steel, step=6)
    # ---- chimney, water tower, tanks, pipe rack, containers
    mp.cyl((70, 30, 25), 3.2, 50, brick, 24, r2=2.0)
    mp.cyl((70, 30, 50.6), 2.15, 1.2, conc, 24)
    tx, ty = 70, -30
    for sx in (-1, 1):
        for sy in (-1, 1):
            mp.box((tx + sx * 2.5, ty + sy * 2.5, 9), (0.4, 0.4, 18), steel)
    mp.cyl((tx, ty, 21), 4.2, 6.0, rust, 24)
    mp.cyl((tx, ty, 24.8), 4.3, 1.6, rust, 24, r2=0.4)
    for i in range(3):
        mp.cyl((-75, -30 + i * 14, 6), 5.5, 12, tex_material("rusty_metal_sheet", 3.0), 24)
    for i in range(14):  # pipe rack between buildings
        x = -60 + i * 6
        mp.box((x, 26, 3.5), (0.3, 0.3, 7), steel)
        mp.box((x, 26, 7.1), (0.3, 4.0, 0.3), steel)
    for k, (yy, r) in enumerate(((25, 0.45), (26, 0.35), (27, 0.3))):
        mp.cyl((-21, yy, 7.6 + r), r, 84, rust, 12, rot=(0, math.pi / 2, 0))
    for i in range(10):
        x, y = 30 + (i % 5) * 2.6, -45 - (i // 5) * 13
        for lvl in range(1 + (i % 3 == 0)):
            mp.box((x, y, 1.3 + lvl * 2.6), (2.44, 12.2, 2.59), [rust, corr, tex_material("painted_metal_shutter", 2.0)][(i + lvl) % 3])
    for i in range(16):
        mp.prop("concrete_road_barrier", (-7 + (i % 8) * 2.2, -100 - (i // 8) * 3, 0), 0)
    for i in range(10):
        mp.prop("old_tyre", (40 + mp.rng.uniform(-6, 6), 0 + mp.rng.uniform(-6, 6), 0), mp.rng.uniform(0, 6))
    for i in range(6):
        mp.prop("modular_electricity_poles", (-100 + i * 30, -120, 0), 0)
    mp.prop("covered_car", (20, -95, 0), 0.4)
    mp.prop("rusted_wheel_rim_01", (24, -92, 0), 1.0)
    mp.spawn((0, -150, 0.1), 0, "road")
    mp.spawn((-40, 0, 0.2), -math.pi / 2, "indoor")
    mp.spawn((5, 24, 6.2), math.pi, "catwalk")
    # freestyle "lines" suggestions for the HUD trainer
    mp.zones.append({"kind": "trick_line", "name": "Сквозь окна цеха", "points": [gpos(p) for p in ((-50, -30, 6), (-40, -18, 8), (-30, 0, 8), (-20, 18, 8), (-10, 30, 6))]})
    mp.zones.append({"kind": "trick_line", "name": "Дырка в крыше", "points": [gpos(p) for p in ((0, 0, 8), (6, 3, 16), (12, 6, 22))]})
    mp.zones.append({"kind": "trick_line", "name": "Труба (power loop)", "points": [gpos(p) for p in ((60, 30, 10), (70, 30, 54), (80, 30, 10))]})
    return mp


def panel_block(mp, cx, cy, length, floors, yaw, conc, slab_m, dmg):
    """Soviet-style 5/9-storey panel apartment block as a damaged concrete shell."""
    fh, depth = 2.8, 12.0
    R = Matrix.Rotation(yaw, 3, "Z")
    def P(lx, ly):
        p = Vector((cx, cy, 0)) + R @ Vector((lx, ly, 0))
        return (p.x, p.y)
    hl, hd = length / 2, depth / 2
    collapse = mp.rng.uniform(0, length * 0.6) if dmg > 0.5 else None
    for f in range(floors):
        z0 = f * fh
        dm = dmg * (0.4 + f / floors)
        for a, b, w in ((P(-hl, -hd), P(hl, -hd), (1.5, 1.5, 0.9)), (P(hl, hd), P(-hl, hd), (1.5, 1.5, 0.9)),
                        (P(-hl, hd), P(-hl, -hd), None), (P(hl, -hd), P(hl, hd), None)):
            mp.wall(a, b, z0, fh, 0.3, conc, bay=3.0, win=w, damage=dm)
        # interior cross walls every 6 m
        for k in range(1, int(length / 6)):
            lx = -hl + k * 6
            if mp.rng.random() > dm * 0.5:
                mp.wall(P(lx, -hd + 0.3), P(lx, hd - 0.3), z0, fh, 0.16, conc, bay=3.0, win=(1.0, 2.1, 0.0), damage=dm)
        # floor slab of this level (roof for the last)
        nx = int(length / 6)
        for i in range(nx):
            for j in range(2):
                lx = -hl + (i + 0.5) * (length / nx)
                ly = -hd / 2 + j * hd
                if collapse is not None and abs(lx - (-hl + collapse)) < 7 and f >= floors - 3:
                    continue
                if mp.rng.random() < dm * 0.18:
                    continue
                p = P(lx, ly)
                mp.box((p[0], p[1], z0 + fh - 0.11), (length / nx, hd, 0.22), slab_m, (0, 0, yaw))
    # balconies on the south face
    for f in range(1, floors):
        for k in range(int(length / 6)):
            if mp.rng.random() < 0.55:
                p = P(-hl + 3 + k * 6, -hd - 0.6)
                mp.box((p[0], p[1], f * 2.8 + 0.05), (2.8, 1.2, 0.15), slab_m, (0, 0, yaw))
                mp.box((p[0] + 0, p[1], f * 2.8 + 0.6), (2.8, 0.08, 1.0), conc, (0, 0, yaw), collide=False) if mp.rng.random() < 0.7 else None
    # stair cores protrude on the roof
    for k in (-1, 1):
        p = P(k * length / 4, 0)
        mp.box((p[0], p[1], floors * fh + 1.2), (3.0, 5.5, 2.4), conc, (0, 0, yaw))


def map_ruined_district():
    mp = Map("ruined_district", "Разрушенный квартал", seed=23)
    mp.env = {"hdri": "overcast_soil_puresky_2k.hdr", "sun": {"dir": gpos((0.2, 0.4, -0.9)), "intensity": 1.4},
              "fog": {"color": [0.62, 0.64, 0.66], "density": 0.004}, "wind": {"mean_ms": 4.0, "gust_ms": 8.0, "dir_deg": 300},
              "dust": True, "time": "overcast", "difficulty": 4,
              "description": "Квартал панельных домов с обрушенными перекрытиями, дворами, машинами и баррикадами."}
    conc = tex_material("concrete_wall_003", 3.0)
    slab = tex_material("rough_concrete", 3.0)
    asph = tex_material("asphalt_02", 4.0)
    walk = tex_material("pavement_02", 2.0)
    dirt = tex_material("acg_grass004", 4.0)
    rubble = tex_material("rebar_reinforced_concrete", 2.0)
    burnt = tex_material("burned_ground_01", 4.0)
    rust = tex_material("rusty_metal_sheet", 2.0)
    pole_m = col_material("pole_concrete", (0.5, 0.5, 0.48), rough=0.8)
    mp.terrain_grid(520, 52, lambda x, y: 0.0 if max(abs(x), abs(y)) < 200 else ((max(abs(x), abs(y)) - 200) / 60) ** 2 * 6, dirt)
    for k in (-1, 0, 1):  # roads grid
        mp.box((k * 80, 0, 0.03), (12, 400, 0.08), asph)
        mp.box((0, k * 80, 0.031), (400, 12, 0.08), asph)
        for s in (-1, 1):
            mp.box((k * 80 + s * 7.5, 0, 0.1), (3, 400, 0.2), walk)
    blocks = [(-40, -40, 60, 9, 0.0, 0.6), (-40, 40, 60, 5, 0.0, 0.3), (40, -40, 48, 5, math.pi / 2, 0.8), (40, 40, 60, 9, 0.0, 0.5),
              (-120, 0, 72, 5, math.pi / 2, 0.4), (120, 0, 60, 9, math.pi / 2, 0.7), (0, 120, 72, 5, 0.0, 0.5), (0, -120, 48, 9, 0.0, 0.9)]
    for cx, cy, L, fl, yaw, d in blocks:
        panel_block(mp, cx, cy, L, fl, yaw, conc, slab, d)
        for k in range(int(10 * d)):  # rubble heaps
            x, y = cx + mp.rng.uniform(-L / 2, L / 2), cy + mp.rng.uniform(-10, 10)
            s = mp.rng.uniform(0.8, 3.0)
            mp.box((x, y, s * 0.25), (s, s * 0.7, s * 0.5), rubble, (mp.rng.uniform(-0.4, 0.4), mp.rng.uniform(-0.4, 0.4), mp.rng.uniform(0, 3)))
    # craters (burnt patches) + burnt cars + barricades + utility poles with wires
    for k in range(18):
        x, y = mp.rng.uniform(-150, 150), mp.rng.uniform(-150, 150)
        mp.cyl((x, y, 0.02), mp.rng.uniform(2, 5), 0.05, burnt, 14, collide=False)
    for k in range(16):
        road = mp.rng.choice((-80, 0, 80))
        if k % 2:
            x, y, yaw = road + mp.rng.uniform(-4, 4), mp.rng.uniform(-150, 150), mp.rng.uniform(-0.5, 0.5)
        else:
            x, y, yaw = mp.rng.uniform(-150, 150), road + mp.rng.uniform(-4, 4), math.pi / 2 + mp.rng.uniform(-0.5, 0.5)
        mp.box((x, y, 0.75), (1.8, 4.4, 1.0), rust, (0, 0, yaw))
        mp.box((x, y - 0.2, 1.5), (1.6, 2.2, 0.6), rust, (0, 0, yaw))
        mp.prop("old_tyre", (x + 1.5, y, 0), mp.rng.uniform(0, 6))
    for k in range(20):
        mp.prop("concrete_road_barrier" if k % 2 else "concrete_road_barrier_02", (-6 + (k % 6) * 2.1, -20 - (k // 6) * 2.5, 0), 0)
    for k in range(-6, 7):
        for sx in (-1, 1):
            mp.cyl((sx * 9.5, k * 28, 4.5), 0.14, 9, pole_m, 8, r2=0.1)
        mp.box((0, k * 28, 8.6), (19, 0.03, 0.03), col_material("wire", (0.02, 0.02, 0.02)), collide=False)
    for k in range(60):
        x, y = mp.rng.uniform(-180, 180), mp.rng.uniform(-180, 180)
        if min(abs(x - r) for r in (-80, 0, 80)) > 10 and min(abs(y - r) for r in (-80, 0, 80)) > 10:
            mp.tree((x, y, 0), mp.rng.uniform(6, 13))
    for i in range(10):
        mp.prop(["metal_trash_can", "utility_box_01", "fire_hydrant", "water_manhole_cover"][i % 4], (8 + i * 9, 9, 0), 0)
    mp.spawn((0, -170, 0.1), 0, "road")
    mp.spawn((40, 40, 26.0), 0, "rooftop")
    mp.zones.append({"kind": "trick_line", "name": "Сквозь подъезды", "points": [gpos(p) for p in ((-70, -46, 3), (-40, -46, 4), (-10, -46, 3))]})
    return mp


def map_parking_garage():
    mp = Map("parking_garage", "Паркинг", seed=5)
    mp.env = {"hdri": "kloofendal_overcast_puresky_2k.hdr", "sun": {"dir": gpos((0.5, 0.2, -0.6)), "intensity": 2.0},
              "fog": {"color": [0.7, 0.72, 0.75], "density": 0.002}, "wind": {"mean_ms": 2.5, "gust_ms": 5.0, "dir_deg": 90},
              "indoor_reverb": True, "time": "day", "difficulty": 2,
              "description": "Многоуровневый открытый паркинг: проёмы, пандусы, крыша — классика FPV-фристайла."}
    conc = tex_material("concrete_wall_008", 3.0)
    floor = tex_material("garage_floor", 4.0)
    asph = tex_material("asphalt_02", 4.0)
    grass = tex_material("acg_grass004", 4.0)
    yellow = col_material("paint_yellow", (0.95, 0.75, 0.05), rough=0.6)
    white = col_material("paint_white", (0.9, 0.9, 0.88), rough=0.6)
    mp.terrain_grid(400, 40, lambda x, y: 0.0, grass)
    mp.box((0, 0, 0.02), (120, 90, 0.1), asph)
    X0, X1, Y0, Y1, FH, L = -36, 36, -24, 24, 3.4, 5
    for lv in range(L):
        z = lv * FH
        hole = lambda i, j: False
        if lv > 0:
            # ramp opening at the east end, 2 tiles
            for i in range(9):
                for j in range(6):
                    if i >= 7 and j in (1, 2):
                        continue
                    mp.box((X0 + (i + 0.5) * 8, Y0 + (j + 0.5) * 8, z - 0.15), (8, 8, 0.3), floor)
            # ramp from previous level
            ang = math.atan2(FH, 16)
            mp.box((X1 - 8, Y0 + 12, z - FH / 2 - 0.15), (math.hypot(16, FH), 8, 0.3), floor, (0, -ang if lv % 2 else ang, 0))
        for i in range(10):
            for j in range(7):
                if lv < L - 1 or (i + j) % 2 == 0:
                    pass
        mp.columns(X0, Y0, X1, Y1, z, FH - 0.3, 0.6, conc, step=8)
        # parapets with gaps
        for a, b in (((X0, Y0), (X1, Y0)), ((X1, Y1), (X0, Y1)), ((X0, Y1), (X0, Y0)), ((X1, Y0), (X1, Y1))):
            mp.wall(a, b, z, 1.0, 0.2, conc, bay=8, damage=0.1)
        # parking lines
        for i in range(17):
            mp.box((X0 + 2 + i * 4, Y0 + 3, z + 0.01), (0.12, 5, 0.01), white, collide=False)
            mp.box((X0 + 2 + i * 4, Y1 - 3, z + 0.01), (0.12, 5, 0.01), white, collide=False)
        for k in range(8):
            mp.lights.append({"type": "point", "pos": gpos((X0 + 4 + k * 9, 0, z + FH - 0.4)), "color": [0.85, 0.95, 1.0],
                              "intensity": 0.6, "range": 10, "flicker": (k + lv) % 5 == 0})
            mp.box((X0 + 4 + k * 9, 0, z + FH - 0.35), (1.2, 0.15, 0.05), col_material("tube_light", (0.85, 0.95, 1.0), emit=6.0), collide=False)
        for k in range(6):
            mp.box((X0 + 0.5, Y0 + 4 + k * 8, z + 0.5), (0.1, 0.15, 0.6), yellow, collide=False)
    mp.slab(X0, Y0, X1, Y1, L * FH, 0.3, floor, tile=8, hole_p=0.0)
    for a, b in (((X0, Y0), (X1, Y0)), ((X1, Y1), (X0, Y1)), ((X0, Y1), (X0, Y0)), ((X1, Y0), (X1, Y1))):
        mp.wall(a, b, L * FH, 1.1, 0.2, conc, bay=8)
    # stair towers
    for sx in (-1, 1):
        x = sx * (X1 + 3)
        mp.wall((x - 3, Y1 - 6), (x + 3, Y1 - 6), 0, L * FH + 3, 0.25, conc, bay=3, win=(1.0, 1.2, 1.4))
        mp.wall((x - 3, Y1), (x + 3, Y1), 0, L * FH + 3, 0.25, conc, bay=3, win=(1.0, 1.2, 1.4))
        mp.wall((x + sx * 3, Y1 - 6), (x + sx * 3, Y1), 0, L * FH + 3, 0.25, conc, bay=3)
        mp.box((x, Y1 - 3, L * FH + 3.1), (6.3, 6.3, 0.25), conc)
    for k in range(12):
        lv = mp.rng.randrange(0, L)
        mp.prop("covered_car", (X0 + 4 + mp.rng.randrange(0, 16) * 4, Y0 + 3 if k % 2 else Y1 - 3, lv * FH + 0.02), math.pi / 2 if k % 2 else -math.pi / 2)
    for k in range(6):
        mp.prop("WetFloorSign_01", (mp.rng.uniform(X0, X1), mp.rng.uniform(-4, 4), mp.rng.randrange(0, L) * FH + 0.02), mp.rng.uniform(0, 6))
    for k in range(8):
        mp.prop("street_lamp_02", (-50 + k * 14, -40, 0), 0)
    mp.spawn((0, -40, 0.1), 0, "street")
    mp.spawn((0, 0, L * FH + 0.2), 0, "rooftop")
    return mp


MAPS = {"training_field": map_training_field, "abandoned_factory": map_abandoned_factory,
        "ruined_district": map_ruined_district, "parking_garage": map_parking_garage}


def build_maps(ids=None, preview_props=False, export=True):
    stats = {}
    for mid in ids or MAPS:
        mp = MAPS[mid]()
        _, stats[mid] = mp.finalize(preview_props=preview_props, export=export)
    return stats
