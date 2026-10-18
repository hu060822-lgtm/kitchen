"""
《NULL：最後一桌》怪物與客人的模型產生器（Blender Python／bpy，無介面執行）。
沿用 build_crew.py 的作法：截面放樣的低多邊形網格、手動權重、64×64 以下的程式貼圖、手寫關鍵影格。

產出（預設寫到 client/public/models/）：
  monster.glb       「後門的東西」：自己的骨架（多一節的手臂、反折的腿、兩節脖子、下顎）＋全部動畫
  guest_suit.glb    永遠不點餐的客人：沿用廚師骨架，臉部比例刻意錯一點
  diner_a..d.glb    一般客人（四種外觀），沿用廚師骨架
  civ_anims.glb     客人用的動畫庫（坐著等、坐著吃、僵直站立、一動也不動地坐著）

執行：
  pip install bpy==5.2.2
  python3 tools/characters/build_creatures.py [輸出資料夾] [--preview 預覽圖資料夾]
"""

import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
import build_crew as bc  # noqa: E402
import bpy  # noqa: E402
import bmesh  # noqa: E402
from mathutils import Euler, Matrix, Vector  # noqa: E402

V = Vector
loft, box, cylinder, mix = bc.loft, bc.box, bc.cylinder, bc.mix
hex_rgb, shade, make_image, make_material = bc.hex_rgb, bc.shade, bc.make_image, bc.make_material

# ======================================================================================
# 共用：任意骨架的骨架物件、網格、動畫烘焙
# ======================================================================================


def make_armature_generic(name, bones, joints):
    data = bpy.data.armatures.new(name)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones
    for bname, h, t, parent in bones:
        bone = eb.new(bname)
        bone.head = V(joints[h])
        bone.tail = V(joints[t])
        ref = V((0, -1, 0)) if abs((bone.tail - bone.head).normalized().y) < 0.9 else V((0, 0, 1))
        bone.align_roll(ref)
        if parent:
            bone.parent = eb[parent]
            bone.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return obj


def make_mesh_generic(name, b, mats, arm, bone_names):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in b.verts], [], [f[0] for f in b.faces])
    me.update()
    for slot in b.slots:
        me.materials.append(mats[slot])
    uv = me.uv_layers.new(name='UVMap')
    for pi, (_idx, uvs, mat) in enumerate(b.faces):
        poly = me.polygons[pi]
        poly.material_index = mat
        poly.use_smooth = False
        for k in range(poly.loop_total):
            uv.data[poly.loop_start + k].uv = uvs[k] if k < len(uvs) else (0.5, 0.5)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # 開放的單面（例如胸口的臉）：重算法線時方向不可靠，改回建立時指定的方向
    bm.faces.ensure_lookup_table()
    bm.normal_update()
    for fi, want in getattr(b, 'keep', {}).items():
        f = bm.faces[fi]
        if f.normal.dot(want) < 0:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    for bn in bone_names:
        obj.vertex_groups.new(name=bn)
    for vi, w in enumerate(b.weights):
        for bn, val in w.items():
            obj.vertex_groups[bn].add([vi], val, 'REPLACE')
    obj.parent = arm
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    return obj


def bake(arm, clips, root='hips'):
    """clips：{名稱: {'length', 'keys': [(影格, 姿勢)], 'loop'}}；姿勢與 build_crew 相同（骨架座標軸的度數，'_loc' 是根骨骼位移）"""
    arm.animation_data_create()
    for name, c in clips.items():
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        arm.animation_data.action = act
        for frame, pose in c['keys']:
            apply_pose(arm, pose, root)
            for pb in arm.pose.bones:
                pb.keyframe_insert('rotation_quaternion', frame=frame + 1)
                if pb.name == root:
                    pb.keyframe_insert('location', frame=frame + 1)
    arm.animation_data.action = None
    apply_pose(arm, {}, root)


def apply_pose(arm, pose, root='hips'):
    rest = {b.name: b.matrix_local.to_quaternion() for b in arm.data.bones}
    for pb in arm.pose.bones:
        rot = pose.get(pb.name, (0, 0, 0))
        q = Euler(tuple(math.radians(a) for a in rot), 'XYZ').to_quaternion()
        r = rest[pb.name]
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = r.inverted() @ q @ r
        pb.location = (r.inverted() @ V(pose.get('_loc', (0, 0, 0)))) if pb.name == root else (0, 0, 0)
        pb.scale = (1, 1, 1)


def clip(length, keys, loop):
    if loop and keys[-1][0] != length:
        keys = keys + [(length, keys[0][1])]
    return {'length': length, 'keys': keys, 'loop': loop}


def merge(*poses):
    return bc.merge(*poses)


def mirror_lr(pose):
    """左右對調（骨骼名稱以 _L／_R 結尾）"""
    return bc.mirror(pose)


def emissive(name, image, strength=2.0):
    mat = make_material(name, image, roughness=0.5)
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    tex = [n for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE'][0]
    mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = strength
    return mat


# ======================================================================================
# 怪物：「後門的東西」
#   太高、太瘦、駝背；兩節脖子把沒有眼睛的頭往前推；下顎從中間裂開，裡面有一排小眼睛。
#   手臂多一節、長到拖地，指頭是四根細長的爪；腿往後反折（像狗的後腿）。
#   身上掛著一條沾滿污漬、破成條狀的廚師圍裙——牠以前「待過」這間廚房。
#   胸口嵌著一張小小的、表情平靜的人臉（模特兒的臉），隨著呼吸起伏。
# ======================================================================================

MJ = {
    'hips': (0.0, 0.05, 1.08),
    'spine': (0.0, 0.0, 1.32),
    'chest': (0.0, -0.16, 1.58),
    'neck': (0.0, -0.36, 1.72),
    'neck2': (0.0, -0.56, 1.72),
    'head': (0.0, -0.74, 1.64),
    'head_end': (0.0, -1.0, 1.5),
    'jaw': (0.0, -0.78, 1.56),
    'jaw_end': (0.0, -0.98, 1.36),
}
for s, sx in (('L', 1), ('R', -1)):
    MJ[f'shoulder_{s}'] = (0.3 * sx, -0.2, 1.62)
    MJ[f'elbow_{s}'] = (0.4 * sx, -0.26, 1.12)
    MJ[f'mid_{s}'] = (0.42 * sx, -0.3, 0.66)
    MJ[f'wrist_{s}'] = (0.42 * sx, -0.28, 0.3)
    MJ[f'hand_end_{s}'] = (0.42 * sx, -0.32, 0.04)
    MJ[f'hip_{s}'] = (0.15 * sx, 0.06, 1.02)
    MJ[f'knee_{s}'] = (0.19 * sx, -0.24, 0.66)
    MJ[f'ankle_{s}'] = (0.17 * sx, 0.2, 0.3)
    MJ[f'toe_{s}'] = (0.17 * sx, -0.06, 0.0)

MBONES = [
    ('hips', 'hips', 'spine', None),
    ('spine', 'spine', 'chest', 'hips'),
    ('chest', 'chest', 'neck', 'spine'),
    ('neck', 'neck', 'neck2', 'chest'),
    ('neck2', 'neck2', 'head', 'neck'),
    ('head', 'head', 'head_end', 'neck2'),
    ('jaw', 'jaw', 'jaw_end', 'head'),
]
for s in ('L', 'R'):
    MBONES += [
        (f'upperArm_{s}', f'shoulder_{s}', f'elbow_{s}', 'chest'),
        (f'foreArm_{s}', f'elbow_{s}', f'mid_{s}', f'upperArm_{s}'),
        (f'midArm_{s}', f'mid_{s}', f'wrist_{s}', f'foreArm_{s}'),
        (f'hand_{s}', f'wrist_{s}', f'hand_end_{s}', f'midArm_{s}'),
        (f'thigh_{s}', f'hip_{s}', f'knee_{s}', 'hips'),
        (f'shin_{s}', f'knee_{s}', f'ankle_{s}', f'thigh_{s}'),
        (f'foot_{s}', f'ankle_{s}', f'toe_{s}', f'shin_{s}'),
    ]
MBONE_NAMES = [b[0] for b in MBONES]


def flesh_painter(base, vein, seed):
    """蒼白發灰的皮：斑駁、深色血管紋、濕亮的斑塊"""
    c = hex_rgb(base)
    vc = hex_rgb(vein)

    def paint(put, w, h):
        r = random.Random(seed)
        for y in range(h):
            for x in range(w):
                k = 1.0 + (r.random() - 0.5) * 0.18
                k *= 0.9 + 0.12 * math.sin(x * 0.7 + y * 0.31) * math.sin(y * 0.23)
                put(x, y, shade(c, k))
        # 血管：隨機遊走的深色線
        for _ in range(9):
            x, y = r.randrange(w), r.randrange(h)
            for _ in range(40):
                put(x, y, shade(vc, 0.9 + r.random() * 0.2))
                x = (x + r.choice((-1, 0, 1))) % w
                y = (y + r.choice((0, 1, 1))) % h
        # 濕亮與瘀青的斑塊
        for _ in range(6):
            cx, cy, rad = r.randrange(w), r.randrange(h), r.randint(2, 5)
            tone = r.choice((1.25, 0.55))
            for yy in range(-rad, rad + 1):
                for xx in range(-rad, rad + 1):
                    if xx * xx + yy * yy <= rad * rad and r.random() < 0.7:
                        put((cx + xx) % w, (cy + yy) % h, shade(c, tone))

    return paint


def apron_painter(seed):
    """原本是白色的廚師圍裙：泛黃、大片乾掉的深褐色污漬、下緣撕裂"""
    base = hex_rgb('#A39B86')
    stain = hex_rgb('#3B2118')

    def paint(put, w, h):
        r = random.Random(seed)
        for y in range(h):
            for x in range(w):
                k = 1.0 + (r.random() - 0.5) * 0.1 - 0.25 * max(0.0, 0.5 - y / h)
                put(x, y, shade(base, k))
        for _ in range(14):
            cx, cy = r.randrange(w), r.randrange(h)
            for _ in range(70):
                put(cx, cy, shade(stain, 0.8 + r.random() * 0.5))
                cx = (cx + r.choice((-1, 0, 1))) % w
                cy = max(0, cy - r.choice((0, 1, 1)))  # 往下流
        for x in range(w):  # 撕裂的下緣：透明
            for y in range(r.randint(0, 6)):
                put(x, y, (0, 0, 0), 0.0)

    return paint


def mask_painter(seed):
    """胸口那張臉：像模特兒一樣平靜、閉著眼、嘴角微微上揚；邊緣的皮肉往內翻"""
    skin = hex_rgb('#C2B6A4')
    dark = hex_rgb('#2E2420')
    rim = hex_rgb('#5A2A2A')

    def paint(put, w, h):
        r = random.Random(seed)
        for y in range(h):
            for x in range(w):
                dx = (x + 0.5 - w / 2) / (w / 2)
                dy = (y + 0.5 - h / 2) / (h / 2)
                d = dx * dx * 1.25 + dy * dy
                if d > 1:
                    put(x, y, shade(rim, 0.7 + r.random() * 0.4))
                elif d > 0.82:
                    put(x, y, shade(rim, 1.1 + r.random() * 0.2))
                else:
                    put(x, y, shade(skin, 1.02 - 0.25 * dx * dx - 0.1 * max(0, -dy) + (r.random() - 0.5) * 0.04))
        cx = w / 2
        ey = int(h * 0.6)
        for side in (-1, 1):  # 閉著的眼：往下彎的弧線＋眼窩陰影
            for k in range(-3, 4):
                x = int(cx + side * 6 + k)
                put(x, ey - (1 if abs(k) < 2 else 0), dark)
                put(x, ey + 1, shade(skin, 0.78))
            for k in range(-3, 4):
                put(int(cx + side * 6 + k), ey + 3, shade(skin, 0.86))  # 眉骨下的陰影
        for y in range(int(h * 0.38), ey - 1):  # 鼻樑陰影
            put(int(cx) + 1, y, shade(skin, 0.82))
        for k in (-2, -1, 0, 1, 2):
            put(int(cx) + k, int(h * 0.38), shade(skin, 0.7))
        my = int(h * 0.26)
        for k in range(-5, 6):  # 嘴：細線，兩端微微上揚
            put(int(cx) + k, my + (1 if abs(k) >= 4 else 0), dark)
            put(int(cx) + k, my - 1, shade(skin, 0.8))

    return paint

def disc(b, center, rot, rx, rz, mat, w, sides=10, bulge=0.0):
    """面向 −Y 的橢圓面（中心略為鼓起），貼圖以平面投影對上（整張臉不會被切開）；背面另外一層頂點"""
    c = V(center)
    for back, dy in ((False, 0.0), (True, 0.006)):
        mid = b.vert(tuple(c + rot @ V((0, dy - (0 if back else bulge), 0))), w)
        ring = []
        uvs = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            x, z = math.cos(a), math.sin(a)
            ring.append(b.vert(tuple(c + rot @ V((x * rx, dy, z * rz))), w))
            uvs.append((0.5 + 0.5 * x, 0.5 + 0.5 * z))
        for k in range(sides):
            k2 = (k + 1) % sides
            if back:
                b.face([mid, ring[k2], ring[k]], [(0.5, 0.5), uvs[k2], uvs[k]], mat)
            else:
                b.face([mid, ring[k], ring[k2]], [(0.5, 0.5), uvs[k], uvs[k2]], mat)
            if not hasattr(b, 'keep'):
                b.keep = {}
            b.keep[len(b.faces) - 1] = rot @ V((0, 1 if back else -1, 0))


def build_monster(b):
    def mw(*pairs):
        return dict(pairs)

    # ---- 軀幹：腰細得不像話，往上突然膨成駝背的胸廓；背後隆起一大塊 ----
    def torso_w(z):
        if z < 1.12:
            return {'hips': 1}
        if z < 1.3:
            t = (z - 1.12) / 0.18
            return {'hips': 1 - t, 'spine': t}
        if z < 1.5:
            t = (z - 1.3) / 0.2
            return {'spine': 1 - t, 'chest': t}
        return {'chest': 1}

    spine_pts = [(0, 0.05, 0.96), (0, 0.06, 1.08), (0, 0.04, 1.2), (0, 0.0, 1.3), (0, -0.05, 1.4),
                 (0, -0.1, 1.5), (0, -0.16, 1.58), (0, -0.24, 1.65), (0, -0.32, 1.7)]
    radii = [(0.13, 0.1), (0.15, 0.11), (0.085, 0.07), (0.13, 0.11), (0.2, 0.17), (0.25, 0.21), (0.25, 0.22), (0.2, 0.18), (0.1, 0.09)]
    rings = []
    for c, (rx, ry) in zip(spine_pts, radii):
        # 駝背：截面中心往背後偏移（胸廓的後半邊比前半邊大很多）
        hump = 0.07 * max(0.0, 1 - abs(c[2] - 1.52) / 0.18)
        rings.append({'c': (c[0], c[1] + hump, c[2]), 'rx': rx, 'ry': ry + hump * 0.5, 'w': torso_w(c[2])})
    loft(b, rings, 'flesh', sides=10, phase=math.pi / 10)

    # 肋骨：一根根從背後繞到前面、浮在皮膚外面
    for i in range(5):
        z = 1.33 + i * 0.065
        k = max(0.0, 1 - abs(z - 1.5) / 0.25)
        rx = 0.15 + 0.11 * k
        ry = 0.13 + 0.1 * k
        yc = -0.06 - (z - 1.33) * 0.55 + 0.06 * k
        w = torso_w(z)
        for sx in (1, -1):
            pts = []
            for j in range(6):
                # 從背後（+Y）繞到胸前（−Y）
                th = 1.0 + (math.pi - 1.15) * j / 5  # 只有側面到胸前，不要從背後戳出來
                pts.append((sx * rx * math.sin(th), yc + ry * math.cos(th), z - 0.04 * j / 5))
            for j in range(len(pts) - 1):
                cylinder(b, pts[j], pts[j + 1], 0.014, 'bone', w, sides=4)

    # 背上一節節突出的脊椎骨
    for i in range(10):
        t = i / 9
        c = V(mix(spine_pts[1], spine_pts[-1], t))
        hump = 0.07 * max(0.0, 1 - abs(c.z - 1.52) / 0.18)
        back = V((0, 0.13 + 0.09 * math.sin(t * math.pi) + hump, 0.02))
        box(b, tuple(c + back), (0.05, 0.08, 0.05), 'bone', torso_w(c.z), rot=Matrix.Rotation(-0.7 * t, 3, 'X'))

    # 胸口嵌著的臉（模特兒的臉，平靜地閉著眼）
    disc(b, (0.0, -0.3, 1.47), Matrix.Rotation(0.5, 3, 'X'), 0.1, 0.125, 'mask', {'chest': 1}, sides=10, bulge=0.02)

    # ---- 兩節脖子：細長、骨節分明 ----
    loft(b, [
        {'c': MJ['neck'], 'rx': 0.07, 'ry': 0.065, 'w': {'chest': 0.4, 'neck': 0.6}},
        {'c': mix(MJ['neck'], MJ['neck2'], 0.5), 'rx': 0.05, 'ry': 0.05, 'w': {'neck': 1}},
        {'c': MJ['neck2'], 'rx': 0.062, 'ry': 0.058, 'w': {'neck': 0.5, 'neck2': 0.5}},
        {'c': mix(MJ['neck2'], MJ['head'], 0.5), 'rx': 0.046, 'ry': 0.046, 'w': {'neck2': 1}},
        {'c': MJ['head'], 'rx': 0.06, 'ry': 0.06, 'w': {'neck2': 0.3, 'head': 0.7}},
    ], 'flesh', sides=6)

    # ---- 頭：沒有眼睛的長形顱骨（上顎） ----
    hw = {'head': 1}
    hx, hy, hz = MJ['head']
    loft(b, [
        {'c': (hx, hy + 0.06, hz + 0.02), 'rx': 0.08, 'ry': 0.09, 'w': hw},
        {'c': (hx, hy - 0.04, hz + 0.07), 'rx': 0.145, 'ry': 0.13, 'w': hw},
        {'c': (hx, hy - 0.15, hz + 0.04), 'rx': 0.13, 'ry': 0.11, 'w': hw},
        {'c': (hx, hy - 0.26, hz - 0.05), 'rx': 0.09, 'ry': 0.06, 'w': hw},
        {'c': (hx, hy - 0.32, hz - 0.12), 'rx': 0.035, 'ry': 0.03, 'w': hw},
    ], 'skull', sides=8, phase=math.pi / 2)
    # 上排牙：一圈細長的三角
    for i in range(9):
        a = math.pi * (0.15 + 0.7 * i / 8)
        x = math.cos(a) * 0.075
        y = hy - 0.06 - math.sin(a) * 0.17
        base = V((x, y, hz - 0.03))
        tip = base + V((0, -0.01, -0.07 - 0.03 * (i % 2)))
        cylinder(b, tuple(base), tuple(tip), 0.012, 'tooth', hw, sides=4, r2=0.001)
    # 嘴裡的一排小眼睛（不對稱、大小不一）：只有張嘴時看得到
    for i, (ex, ez, rs) in enumerate([(-0.04, -0.035, 0.014), (-0.012, -0.03, 0.009), (0.015, -0.038, 0.016), (0.042, -0.032, 0.008), (0.0, -0.05, 0.011)]):
        box(b, (ex, hy - 0.1 - i * 0.012, hz + ez), (rs, rs * 0.6, rs), 'eye', hw)
    # ---- 下顎：從中間裂開，張很大 ----
    jw = {'jaw': 1}
    jx, jy, jz = MJ['jaw']
    loft(b, [
        {'c': (jx, jy + 0.02, jz - 0.02), 'rx': 0.075, 'ry': 0.04, 'w': jw, 'frame': (V((1, 0, 0)), V((0, 0.3, 1)).normalized())},
        {'c': (jx, jy - 0.1, jz - 0.08), 'rx': 0.07, 'ry': 0.035, 'w': jw, 'frame': (V((1, 0, 0)), V((0, 0.3, 1)).normalized())},
        {'c': (jx, jy - 0.19, jz - 0.17), 'rx': 0.035, 'ry': 0.022, 'w': jw, 'frame': (V((1, 0, 0)), V((0, 0.3, 1)).normalized())},
    ], 'skull', sides=6)
    for i in range(7):
        t = i / 6
        base = V((-0.05 + 0.1 * t, jy - 0.05 - 0.08 * math.sin(t * math.pi), jz - 0.06))
        cylinder(b, tuple(base), tuple(base + V((0, 0.0, 0.06))), 0.01, 'tooth', jw, sides=4, r2=0.001)

    # ---- 手臂：三節，太長，垂到地面 ----
    for s, sx in (('L', 1), ('R', -1)):
        sh, el, md, wr, he = (MJ[f'{k}_{s}'] for k in ('shoulder', 'elbow', 'mid', 'wrist', 'hand_end'))
        loft(b, [
            {'c': mix(MJ['chest'], sh, 0.4), 'rx': 0.09, 'ry': 0.09, 'w': {'chest': 1}},
            {'c': sh, 'rx': 0.1, 'ry': 0.095, 'w': {'chest': 0.4, f'upperArm_{s}': 0.6}},
            {'c': mix(sh, el, 0.3), 'rx': 0.07, 'ry': 0.075, 'w': {f'upperArm_{s}': 1}},
            {'c': mix(sh, el, 0.65), 'rx': 0.048, 'ry': 0.052, 'w': {f'upperArm_{s}': 1}},
            {'c': el, 'rx': 0.052, 'ry': 0.05, 'w': {f'upperArm_{s}': 0.5, f'foreArm_{s}': 0.5}},
            {'c': mix(el, md, 0.5), 'rx': 0.035, 'ry': 0.04, 'w': {f'foreArm_{s}': 1}},
            {'c': md, 'rx': 0.045, 'ry': 0.042, 'w': {f'foreArm_{s}': 0.5, f'midArm_{s}': 0.5}},  # 多出來的那個關節
            {'c': mix(md, wr, 0.5), 'rx': 0.03, 'ry': 0.034, 'w': {f'midArm_{s}': 1}},
            {'c': wr, 'rx': 0.04, 'ry': 0.035, 'w': {f'midArm_{s}': 0.4, f'hand_{s}': 0.6}},
        ], 'flesh', sides=6)
        # 關節上突出的骨頭
        for j in (el, md):
            box(b, (j[0] + 0.02 * sx, j[1] + 0.03, j[2]), (0.03, 0.04, 0.05), 'bone', {f'foreArm_{s}': 1} if j is el else {f'midArm_{s}': 1})
        # 手掌與四根爪
        hw2 = {f'hand_{s}': 1}
        loft(b, [
            {'c': wr, 'rx': 0.04, 'ry': 0.03, 'w': hw2},
            {'c': mix(wr, he, 0.35), 'rx': 0.055, 'ry': 0.025, 'w': hw2},
        ], 'flesh', sides=6)
        palm_end = V(mix(wr, he, 0.35))
        for k, off in enumerate((-0.045, -0.015, 0.015, 0.045)):
            a = palm_end + V((off * sx * 0.4, off, 0))
            c = V(he) + V((off * sx * 0.6, off * 1.6 - 0.02, -0.02 * (k % 2)))
            m = V(mix(tuple(a), tuple(c), 0.55)) + V((0, -0.03, 0.02))
            cylinder(b, tuple(a), tuple(m), 0.012, 'flesh', hw2, sides=4, r2=0.009)
            cylinder(b, tuple(m), tuple(c), 0.009, 'claw', hw2, sides=4, r2=0.001)

        # ---- 腿：反折，細，腳掌像蹄又像手 ----
        hp, kn, an, to = (MJ[f'{k}_{s}'] for k in ('hip', 'knee', 'ankle', 'toe'))
        loft(b, [
            {'c': hp, 'rx': 0.085, 'ry': 0.085, 'w': {'hips': 0.5, f'thigh_{s}': 0.5}},
            {'c': mix(hp, kn, 0.5), 'rx': 0.06, 'ry': 0.065, 'w': {f'thigh_{s}': 1}},
            {'c': kn, 'rx': 0.05, 'ry': 0.05, 'w': {f'thigh_{s}': 0.5, f'shin_{s}': 0.5}},
            {'c': mix(kn, an, 0.5), 'rx': 0.032, 'ry': 0.036, 'w': {f'shin_{s}': 1}},
            {'c': an, 'rx': 0.04, 'ry': 0.035, 'w': {f'shin_{s}': 0.5, f'foot_{s}': 0.5}},
            {'c': mix(an, to, 0.7), 'rx': 0.03, 'ry': 0.028, 'w': {f'foot_{s}': 1}},
        ], 'flesh', sides=6)
        box(b, (kn[0], kn[1] - 0.03, kn[2]), (0.05, 0.04, 0.06), 'bone', {f'thigh_{s}': 0.5, f'shin_{s}': 0.5})
        fw = {f'foot_{s}': 1}
        for off in (-0.04, 0.0, 0.04):
            a = V(mix(an, to, 0.7))
            c = V(to) + V((off * sx, -0.06, 0.0))
            cylinder(b, tuple(a), tuple(c), 0.014, 'claw', fw, sides=4, r2=0.003)

    # ---- 破爛的圍裙：從胸口垂到大腿，下緣撕成條狀 ----
    def apron_w(_a, p):
        lft = max(0.0, min(1.0, 0.5 + p.x / 0.3))
        z = p.z
        w = {'hips': 1.0}
        if z > 1.3:
            w = {'chest': 1.0}
        elif z > 1.15:
            w = {'spine': 1.0}
        elif z < 0.95:
            w = {'hips': 0.5, 'thigh_L': 0.6 * lft, 'thigh_R': 0.6 * (1 - lft)}
        return w

    strips = 5
    for i in range(strips):
        x0 = -0.2 + 0.4 * i / strips
        x1 = x0 + 0.4 / strips * 0.92
        top = 1.36
        bottom = 0.84 - 0.09 * ((i * 7) % 3)
        ytop, ybot = -0.24, -0.17
        quad = [
            b.vert((x0, ytop + 0.02 * abs(x0), top), apron_w(0, V((x0, 0, top)))),
            b.vert((x1, ytop + 0.02 * abs(x1), top), apron_w(0, V((x1, 0, top)))),
            b.vert((x1 * 1.1, ybot, bottom), apron_w(0, V((x1, 0, bottom)))),
            b.vert((x0 * 1.1, ybot, bottom), apron_w(0, V((x0, 0, bottom)))),
        ]
        u0 = i / strips
        u1 = (i + 0.9) / strips
        b.face(quad, [(u0, 1), (u1, 1), (u1, 0.1), (u0, 0.1)], 'apron')
        b.face(list(reversed(quad)), [(u0, 0.1), (u1, 0.1), (u1, 1), (u0, 1)], 'apron')
    # 圍裙的繫帶（勒進脖子）
    loft(b, [
        {'c': (0.18, -0.24, 1.36), 'rx': 0.01, 'ry': 0.01, 'w': {'chest': 1}},
        {'c': (0.2, -0.27, 1.55), 'rx': 0.01, 'ry': 0.01, 'w': {'chest': 1}},
        {'c': (0.08, -0.4, 1.74), 'rx': 0.01, 'ry': 0.01, 'w': {'neck': 1}},
        {'c': (-0.08, -0.4, 1.74), 'rx': 0.01, 'ry': 0.01, 'w': {'neck': 1}},
        {'c': (-0.2, -0.27, 1.55), 'rx': 0.01, 'ry': 0.01, 'w': {'chest': 1}},
        {'c': (-0.18, -0.24, 1.36), 'rx': 0.01, 'ry': 0.01, 'w': {'chest': 1}},
    ], 'apron', sides=4)


def monster_materials():
    return {
        'flesh': make_material('m_flesh', make_image('m_flesh', 64, 64, flesh_painter('#86837A', '#4E2329', 11)), roughness=0.38),
        'skull': make_material('m_skull', make_image('m_skull', 32, 32, flesh_painter('#A39C8E', '#5E5048', 12)), roughness=0.45),
        'bone': make_material('m_bone', make_image('m_bone', 16, 16, bc.solid_painter('#A8A08A', 13, 0.18, 0.1)), roughness=0.6),
        'tooth': make_material('m_tooth', make_image('m_tooth', 8, 8, bc.solid_painter('#D8D2B8', 14, 0.1)), roughness=0.4),
        'claw': make_material('m_claw', make_image('m_claw', 8, 8, bc.solid_painter('#2A2622', 15, 0.15)), roughness=0.4),
        'eye': emissive('m_eye', make_image('m_eye', 4, 4, bc.solid_painter('#E6E0B8', 16, 0.05)), 3.0),
        'mask': make_material('m_mask', make_image('m_mask', 32, 40, mask_painter(17)), roughness=0.7),
        'apron': cutout(make_material('m_apron', make_image('m_apron', 32, 64, apron_painter(18)), roughness=0.95)),
    }


def cutout(mat):
    """貼圖的透明處挖空（客戶端以 alphaTest 呈現）"""
    nt = mat.node_tree
    tex = [n for n in nt.nodes if n.type == 'TEX_IMAGE'][0]
    nt.links.new(tex.outputs['Alpha'], nt.nodes.get('Principled BSDF').inputs['Alpha'])
    return mat


# ---- 怪物的動作 ----
#   X 正值＝往前傾／往後擺（與廚師相同的約定）
M_STAND = {
    'spine': (4, 0, 0), 'chest': (4, 0, 0), 'neck': (-6, 0, 0), 'neck2': (6, 0, 0), 'head': (4, 0, 0), 'jaw': (-6, 0, 0),
    'upperArm_L': (4, 4, 0), 'upperArm_R': (4, -4, 0), 'foreArm_L': (-6, 0, 0), 'foreArm_R': (-6, 0, 0),
    'midArm_L': (8, 0, 0), 'midArm_R': (8, 0, 0), '_loc': (0, 0, 0),
}


def m_pose(**kw):
    return merge(M_STAND, kw.pop('extra', {}), kw)


M_WALK_A = merge(M_STAND, {
    '_loc': (0, 0, -0.03), 'hips': (0, 0, -6), 'spine': (6, 0, 5), 'chest': (4, -6, 0), 'neck2': (6, 8, 0),
    'thigh_L': (-26, 0, 0), 'shin_L': (14, 0, 0), 'foot_L': (6, 0, 0),
    'thigh_R': (18, 0, 0), 'shin_R': (-20, 0, 0), 'foot_R': (-14, 0, 0),
    'upperArm_L': (14, 4, 0), 'foreArm_L': (8, 0, 0), 'upperArm_R': (-10, -4, 0), 'foreArm_R': (-14, 0, 0),
})
M_WALK_B = merge(M_STAND, {
    '_loc': (0, 0, 0.02), 'spine': (5, 0, 0), 'neck2': (2, -4, 0), 'head': (6, 0, 6),
    'thigh_L': (2, 0, 0), 'shin_L': (2, 0, 0), 'thigh_R': (-6, 0, 0), 'shin_R': (-34, 0, 0), 'foot_R': (16, 0, 0),
})
M_RUN_A = merge(M_STAND, {
    '_loc': (0, -0.05, -0.12), 'hips': (0, 0, -8), 'spine': (26, 0, 6), 'chest': (16, -8, 0), 'neck': (-18, 0, 0), 'neck2': (-6, 0, 0), 'head': (-10, 0, 0),
    'jaw': (-18, 0, 0),
    'thigh_L': (-44, 0, 0), 'shin_L': (24, 0, 0), 'foot_L': (12, 0, 0),
    'thigh_R': (30, 0, 0), 'shin_R': (-30, 0, 0), 'foot_R': (-24, 0, 0),
    'upperArm_L': (-46, 10, 0), 'foreArm_L': (-20, 0, 0), 'midArm_L': (24, 0, 0),
    'upperArm_R': (36, -10, 0), 'foreArm_R': (14, 0, 0), 'midArm_R': (-10, 0, 0),
})
M_RUN_B = merge(M_STAND, {
    '_loc': (0, -0.05, -0.02), 'spine': (24, 0, 0), 'chest': (14, 0, 0), 'neck': (-16, 0, 0), 'head': (-8, 0, 0), 'jaw': (-24, 0, 0),
    'thigh_L': (-2, 0, 0), 'shin_L': (0, 0, 0), 'thigh_R': (-20, 0, 0), 'shin_R': (-60, 0, 0), 'foot_R': (30, 0, 0),
    'upperArm_L': (-10, 10, 0), 'upperArm_R': (-6, -10, 0),
})
M_WINDUP = merge(M_STAND, {
    '_loc': (0, 0.06, 0.06), 'spine': (-16, 0, 0), 'chest': (-12, 0, 0), 'neck': (-4, 0, 0), 'neck2': (6, 0, 0), 'head': (4, 0, 0),
    'jaw': (-58, 0, 0),
    'upperArm_L': (-130, 0, 30), 'upperArm_R': (-130, 0, -30), 'foreArm_L': (-30, 0, 20), 'foreArm_R': (-30, 0, -20),
    'midArm_L': (-40, 0, 0), 'midArm_R': (-40, 0, 0), 'hand_L': (-30, 0, 0), 'hand_R': (-30, 0, 0),
    'thigh_L': (-14, 0, 0), 'thigh_R': (10, 0, 0), 'shin_L': (10, 0, 0), 'shin_R': (-8, 0, 0),
})
M_GRAB = merge(M_STAND, {
    '_loc': (0, -0.25, -0.1), 'spine': (34, 0, 0), 'chest': (20, 0, 0), 'neck': (-20, 0, 0), 'head': (-14, 0, 0), 'jaw': (-50, 0, 0),
    'upperArm_L': (-96, -10, 0), 'upperArm_R': (-96, 10, 0), 'foreArm_L': (-20, 0, -30), 'foreArm_R': (-20, 0, 30),
    'midArm_L': (-30, 0, 0), 'midArm_R': (-30, 0, 0), 'hand_L': (40, 0, 0), 'hand_R': (40, 0, 0),
    'thigh_L': (-40, 0, 0), 'shin_L': (30, 0, 0), 'thigh_R': (30, 0, 0), 'shin_R': (-24, 0, 0),
})

MONSTER_CLIPS = {
    # 待機：呼吸、脖子不規則地抽動、下顎一開一合
    'Idle': clip(90, [
        (0, M_STAND),
        (20, merge(M_STAND, {'chest': (-2, 0, 0), 'jaw': (-14, 0, 0)})),
        (34, merge(M_STAND, {'neck2': (10, 22, 0), 'head': (0, 0, 28)})),  # 突然歪頭
        (38, merge(M_STAND, {'neck2': (10, 22, 0), 'head': (0, 0, 30), 'jaw': (-22, 0, 0)})),
        (60, merge(M_STAND, {'neck2': (2, -6, 0), 'jaw': (-4, 0, 0)})),
        (72, merge(M_STAND, {'hand_L': (0, 0, 20), 'hand_R': (0, 0, -16)})),
    ], True),
    # 巡邏：慢、拖著手、一高一低
    'Walk': clip(48, [(0, M_WALK_A), (12, M_WALK_B), (24, mirror_lr(M_WALK_A)), (36, mirror_lr(M_WALK_B))], True),
    # 調查：更慢，頭左右掃
    'Investigate': clip(64, [
        (0, merge(M_WALK_A, {'neck2': (4, 26, 0), 'head': (0, 0, 20)})),
        (16, merge(M_WALK_B, {'neck2': (0, 10, 0)})),
        (32, merge(mirror_lr(M_WALK_A), {'neck2': (4, -26, 0), 'head': (0, 0, -20)})),
        (48, merge(mirror_lr(M_WALK_B), {'neck2': (0, -10, 0)})),
    ], True),
    # 追逐：身體壓低前傾、手臂往前甩、嘴半開
    'Chase': clip(18, [(0, M_RUN_A), (5, M_RUN_B), (9, mirror_lr(M_RUN_A)), (14, mirror_lr(M_RUN_B))], True),
    # 撲抓預備（0.9 秒）：往後仰、雙臂高舉張開、下顎張到極限，最後一瞬間顫抖
    'Windup': clip(27, [
        (0, M_RUN_B),
        (8, M_WINDUP),
        (20, merge(M_WINDUP, {'jaw': (-64, 0, 0), 'neck2': (2, 8, 0), 'head': (4, 0, 10)})),
        (23, merge(M_WINDUP, {'jaw': (-60, 0, 0), 'neck2': (8, -8, 0), 'head': (4, 0, -10)})),
        (27, merge(M_WINDUP, {'jaw': (-64, 0, 0)})),
    ], False),
    # 撲上去
    'Grab': clip(16, [(0, M_WINDUP), (5, M_GRAB), (16, M_GRAB)], False),
    # 搜索：站著，頭一頓一頓地轉向不同方向
    'Search': clip(80, [
        (0, M_STAND),
        (6, merge(M_STAND, {'neck2': (12, 30, 0), 'head': (0, 0, 24)})),
        (24, merge(M_STAND, {'neck2': (12, 30, 0), 'head': (0, 0, 24)})),
        (28, merge(M_STAND, {'neck2': (-8, -24, 0), 'head': (-10, 0, -34), 'jaw': (-20, 0, 0)})),
        (50, merge(M_STAND, {'neck2': (-8, -24, 0), 'head': (-10, 0, -34)})),
        (54, merge(M_STAND, {'spine': (16, 0, 0), 'neck': (-14, 0, 0), 'neck2': (20, 0, 0)})),
        (72, merge(M_STAND, {'spine': (16, 0, 0), 'neck': (-14, 0, 0), 'neck2': (20, 0, 0)})),
    ], True),
}


# ======================================================================================
# 客人（沿用廚師骨架 bc.BONES）
# ======================================================================================

J = bc.J


def build_civilian(b, cfg):
    """便服的人：上衣、長褲或裙、鞋、頭髮；比例可以調（神秘客人刻意放大頭、拉長脖子）"""
    hs = cfg.get('head_scale', 1.0)
    neck_extra = cfg.get('neck_extra', 0.0)
    top = 'top'
    loft(b, [
        {'c': (0, 0.005, 0.86), 'rx': 0.125, 'ry': 0.09, 'w': bc.side_weight({'hips': 1}, 'upperLeg_L', 'upperLeg_R', 0.9)},
        {'c': (0, 0.008, 0.95), 'rx': 0.16, 'ry': 0.11, 'w': bc.side_weight({'hips': 1}, 'upperLeg_L', 'upperLeg_R', 0.35)},
        {'c': (0, 0.004, 1.05), 'rx': 0.15, 'ry': 0.105, 'w': {'hips': 0.6, 'spine': 0.4}},
    ], 'pants', sides=8, phase=math.pi / 8, cap0=True, cap1=False)
    loft(b, [
        {'c': (0, 0.004, 1.02), 'rx': 0.155, 'ry': 0.108, 'w': {'hips': 0.7, 'spine': 0.3}},
        {'c': (0, 0.0, 1.15), 'rx': 0.148, 'ry': 0.102, 'w': {'spine': 1}},
        {'c': (0, -0.005, 1.25), 'rx': 0.168, 'ry': 0.115, 'w': {'spine': 0.4, 'chest': 0.6}},
        {'c': (0, -0.006, 1.34), 'rx': 0.18, 'ry': 0.12, 'w': {'chest': 1}},
        {'c': (0, -0.002, 1.41), 'rx': 0.185, 'ry': 0.11, 'w': {'chest': 1}},
        {'c': (0, 0.005, 1.45), 'rx': 0.11, 'ry': 0.085, 'w': {'chest': 0.7, 'neck': 0.3}},
    ], top, sides=8, phase=math.pi / 8)
    if cfg.get('skirt'):
        loft(b, [
            {'c': (0, 0.004, 1.02), 'rx': 0.16, 'ry': 0.112, 'w': {'hips': 1}},
            {'c': (0, 0.006, 0.82), 'rx': 0.22, 'ry': 0.16, 'w': bc.coat_weight(0.6)},
            {'c': (0, 0.006, 0.6), 'rx': 0.25, 'ry': 0.18, 'w': bc.coat_weight(1.2)},
        ], 'skirt', sides=10, cap0=False, cap1=False)
    if cfg.get('jacket'):
        loft(b, [
            {'c': (0, 0.006, 1.452), 'rx': 0.115, 'ry': 0.09, 'w': {'chest': 0.8, 'neck': 0.2}},
            {'c': (0, -0.002, 1.4), 'rx': 0.2, 'ry': 0.125, 'w': {'chest': 1}},
            {'c': (0, -0.008, 1.3), 'rx': 0.19, 'ry': 0.13, 'w': {'chest': 1}},
            {'c': (0, -0.004, 1.15), 'rx': 0.165, 'ry': 0.115, 'w': {'spine': 1}},
            {'c': (0, 0.002, 1.0), 'rx': 0.175, 'ry': 0.12, 'w': {'hips': 1}},
            {'c': (0, 0.004, 0.9), 'rx': 0.185, 'ry': 0.13, 'w': bc.coat_weight(0.4)},
        ], 'jacket', sides=10, phase=math.pi / 10, cap0=False, cap1=False)
        box(b, (0, -0.128, 1.3), (0.07, 0.008, 0.2), 'shirt', {'chest': 1})  # 襯衫的 V 領
        if cfg.get('tie'):
            box(b, (0, -0.134, 1.27), (0.022, 0.008, 0.2), 'tie', {'chest': 1})
    # 頸與頭（可放大）
    neck_top = 1.55 + neck_extra
    loft(b, [
        {'c': (0, 0.008, 1.43), 'rx': 0.055, 'ry': 0.053, 'w': {'chest': 0.3, 'neck': 0.7}},
        {'c': (0, 0.0, neck_top), 'rx': 0.05, 'ry': 0.052, 'w': {'neck': 0.4, 'head': 0.6}},
    ], 'skin', sides=6)
    hw = {'head': 1}
    base = V((0, -0.005, 1.535 + neck_extra))
    head_rings = [
        ((0, -0.02, 1.535), 0.045, 0.048), ((0, -0.03, 1.565), 0.068, 0.072), ((0, -0.012, 1.615), 0.083, 0.094),
        ((0, -0.005, 1.66), 0.087, 0.1), ((0, 0.0, 1.705), 0.083, 0.097), ((0, 0.005, 1.742), 0.065, 0.078), ((0, 0.008, 1.765), 0.03, 0.036),
    ]
    rings = []
    for c, rx, ry in head_rings:
        p = base + (V(c) - V((0, -0.005, 1.535))) * hs
        rings.append({'c': tuple(p), 'rx': rx * hs, 'ry': ry * hs, 'w': hw})
    loft(b, rings, 'face', sides=8, phase=math.pi / 2)
    for sx in (1, -1):
        box(b, tuple(base + V((0.088 * sx, 0.01, 0.11)) * 1.0 * hs), (0.018 * hs, 0.035 * hs, 0.05 * hs), 'skin', hw)
    hair = cfg.get('hair', 'short')
    top_z = base.z + 0.23 * hs
    if hair in ('short', 'long', 'bun'):
        loft(b, [
            {'c': tuple(base + V((0, 0.012, 0.12)) * hs), 'rx': 0.092 * hs, 'ry': 0.104 * hs, 'w': hw},
            {'c': tuple(base + V((0, 0.012, 0.19)) * hs), 'rx': 0.088 * hs, 'ry': 0.1 * hs, 'w': hw},
            {'c': (base.x, base.y + 0.012, top_z + 0.01), 'rx': 0.035 * hs, 'ry': 0.04 * hs, 'w': hw},
        ], 'hair', sides=8, phase=math.pi / 2, cap0=False)
    if hair == 'long':
        box(b, tuple(base + V((0, 0.06, 0.02)) * hs), (0.17 * hs, 0.06 * hs, 0.26 * hs), 'hair', hw)
    if hair == 'bun':
        box(b, tuple(base + V((0, 0.08, 0.2)) * hs), (0.07 * hs, 0.07 * hs, 0.07 * hs), 'hair', hw)
    if cfg.get('hat'):
        cylinder(b, (0, 0.0, top_z - 0.02), (0, 0.0, top_z + 0.08), 0.1 * hs, 'hat', hw, sides=10)
        cylinder(b, (0, 0.0, top_z - 0.03), (0, 0.0, top_z - 0.01), 0.16 * hs, 'hat', hw, sides=10)
    if cfg.get('glasses'):
        box(b, tuple(base + V((0, -0.098, 0.13)) * hs), (0.15 * hs, 0.012, 0.03 * hs), 'tie', hw)

    for s, sx in (('L', 1), ('R', -1)):
        sh, el, wr, he = J[f'shoulder_{s}'], J[f'elbow_{s}'], J[f'wrist_{s}'], J[f'hand_end_{s}']
        sleeve = 'jacket' if cfg.get('jacket') else top
        loft(b, [
            {'c': mix(J[f'clav_{s}'], sh, 0.55), 'rx': 0.06, 'ry': 0.068, 'w': {'chest': 0.5, f'shoulder_{s}': 0.5}},
            {'c': (sh[0] + 0.01 * sx, sh[1], sh[2] - 0.02), 'rx': 0.066, 'ry': 0.066, 'w': {f'shoulder_{s}': 0.4, f'upperArm_{s}': 0.6}},
            {'c': mix(sh, el, 0.55), 'rx': 0.05, 'ry': 0.052, 'w': {f'upperArm_{s}': 1}},
            {'c': el, 'rx': 0.046, 'ry': 0.048, 'w': {f'upperArm_{s}': 0.5, f'lowerArm_{s}': 0.5}},
            {'c': mix(el, wr, 0.85), 'rx': 0.04, 'ry': 0.038, 'w': {f'lowerArm_{s}': 1}},
        ], sleeve, sides=7, cap1=False)
        loft(b, [
            {'c': mix(el, wr, 0.85), 'rx': 0.033, 'ry': 0.031, 'w': {f'lowerArm_{s}': 1}},
            {'c': wr, 'rx': 0.03, 'ry': 0.03, 'w': {f'lowerArm_{s}': 0.5, f'hand_{s}': 0.5}},
            {'c': mix(wr, he, 0.5), 'rx': 0.022, 'ry': 0.042, 'w': {f'hand_{s}': 1}},
            {'c': he, 'rx': 0.014, 'ry': 0.03, 'w': {f'hand_{s}': 1}},
        ], 'skin', sides=6)
        hp, kn, an = J[f'hip_{s}'], J[f'knee_{s}'], J[f'ankle_{s}']
        loft(b, [
            {'c': (hp[0] * 0.9, hp[1], hp[2] + 0.02), 'rx': 0.085, 'ry': 0.088, 'w': {'hips': 0.5, f'upperLeg_{s}': 0.5}},
            {'c': mix(hp, kn, 0.5), 'rx': 0.072, 'ry': 0.075, 'w': {f'upperLeg_{s}': 1}},
            {'c': kn, 'rx': 0.056, 'ry': 0.058, 'w': {f'upperLeg_{s}': 0.5, f'lowerLeg_{s}': 0.5}},
            {'c': mix(kn, an, 0.6), 'rx': 0.048, 'ry': 0.05, 'w': {f'lowerLeg_{s}': 1}},
            {'c': (an[0], an[1], 0.1), 'rx': 0.045, 'ry': 0.05, 'w': {f'lowerLeg_{s}': 0.5, f'foot_{s}': 0.5}},
        ], 'pants', sides=7, cap0=False)
        fw = {f'foot_{s}': 1}
        box(b, (an[0], -0.04, 0.04), (0.09, 0.24, 0.07), 'shoe', fw)


def face_variant(skin, hair, seed, creepy=False):
    if not creepy:
        return bc.face_painter(skin, hair, seed)
    sk = hex_rgb(skin)
    hr = hex_rgb(hair)
    black = hex_rgb('#0D0D0E')

    def paint(put, w, h):
        r = random.Random(seed)
        for y in range(h):
            for x in range(w):
                u, v = x / w, y / h
                col = shade(sk, 1.0 + (r.random() - 0.5) * 0.03)
                back = abs(u - 0.5) > 0.27
                if v > 0.82 or (back and v > 0.45):
                    col = shade(hr, 1.0 + (r.random() - 0.5) * 0.08)
                put(x, y, col)
        cx = w // 2
        ey = int(h * 0.52)
        # 全黑、太大的眼睛
        for dx in range(-7, -2):
            for dy in range(-1, 3):
                put(cx + dx, ey + dy, black)
        for dx in range(3, 8):
            for dy in range(-1, 3):
                put(cx + dx, ey + dy, black)
        # 咧到耳邊、一直維持著的笑（太寬、太細）
        my = int(h * 0.3)
        for dx in range(-12, 13):
            yy = my + int((dx * dx) / 40)
            put(cx + dx, yy, black)
            if abs(dx) < 10:
                put(cx + dx, yy - 1, shade(sk, 0.7))

    return paint


DINERS = {
    'diner_a': {'top': '#6B4E3D', 'pants': '#2E3236', 'skin': '#A88F7C', 'hair': '#1F1A17', 'hair_style': 'short', 'shoe': '#1B1C1D', 'jacket': '#3D4A55', 'glasses': True},
    'diner_b': {'top': '#8C7A5B', 'pants': '#4A3F37', 'skin': '#C1A58E', 'hair': '#5A3E2C', 'hair_style': 'long', 'shoe': '#2A2523', 'skirt': '#5B3B3B'},
    'diner_c': {'top': '#465346', 'pants': '#25292B', 'skin': '#8E7462', 'hair': '#2B2522', 'hair_style': 'bun', 'shoe': '#151617'},
    'diner_d': {'top': '#9A9789', 'pants': '#3C3F43', 'skin': '#B39A86', 'hair': '#7D7B76', 'hair_style': 'short', 'shoe': '#222222', 'hat': '#3A3530'},
}
GUEST = {'top': '#D8D4C8', 'pants': '#121314', 'skin': '#CFC9BC', 'hair': '#0E0E0F', 'hair_style': 'short', 'shoe': '#0B0B0C',
         'jacket': '#141518', 'tie': True, 'head_scale': 1.12, 'neck_extra': 0.035}


def civilian_materials(name, cfg, creepy=False):
    seed = sum(map(ord, name))
    mats = {
        'top': make_material(f'{name}_top', make_image(f'{name}_top', 32, 32, bc.fabric_painter(cfg['top'], seed, seam=False, grime=0.08))),
        'pants': make_material(f'{name}_pants', make_image(f'{name}_pants', 32, 32, bc.fabric_painter(cfg['pants'], seed + 1, grime=0.1))),
        'skin': make_material(f'{name}_skin', make_image(f'{name}_skin', 8, 8, bc.solid_painter(cfg['skin'], seed + 2, 0.06))),
        'face': make_material(f'{name}_face', make_image(f'{name}_face', 64, 64, face_variant(cfg['skin'], cfg['hair'], seed + 3, creepy))),
        'hair': make_material(f'{name}_hair', make_image(f'{name}_hair', 16, 16, bc.solid_painter(cfg['hair'], seed + 4, 0.15))),
        'shoe': make_material(f'{name}_shoe', make_image(f'{name}_shoe', 8, 8, bc.solid_painter(cfg['shoe'], seed + 5, 0.1))),
        'tie': make_material(f'{name}_tie', make_image(f'{name}_tie', 8, 8, bc.solid_painter('#1A1112' if creepy else '#2A2A2E', seed + 6, 0.1))),
        'shirt': make_material(f'{name}_shirt', make_image(f'{name}_shirt', 8, 8, bc.solid_painter('#E6E2D6', seed + 7, 0.04))),
    }
    for k in ('jacket', 'skirt', 'hat'):
        if k in cfg and isinstance(cfg[k], str):
            mats[k] = make_material(f'{name}_{k}', make_image(f'{name}_{k}', 32, 32, bc.fabric_painter(cfg[k], seed + 8, seam=k == 'jacket', grime=0.06)))
    if 'jacket' not in mats and cfg.get('jacket'):
        mats['jacket'] = mats['top']
    return mats


# ---- 客人的動作（坐姿：髖部降到椅面高度 0.47 m） ----
SIT = {
    '_loc': (0, 0.06, -0.47),
    'spine': (4, 0, 0), 'chest': (2, 0, 0), 'neck': (2, 0, 0), 'head': (4, 0, 0),
    'upperLeg_L': (-88, -4, 0), 'upperLeg_R': (-88, 4, 0), 'lowerLeg_L': (88, 0, 0), 'lowerLeg_R': (88, 0, 0),
    'foot_L': (0, 0, 0), 'foot_R': (0, 0, 0),
    'upperArm_L': (-34, 8, 0), 'upperArm_R': (-34, -8, 0), 'lowerArm_L': (-58, 0, -8), 'lowerArm_R': (-58, 0, 8),
    'hand_L': (-6, 0, 0), 'hand_R': (-6, 0, 0),
}
SIT_HANDS_LAP = merge(SIT, {'upperArm_L': (6, 0, 0), 'upperArm_R': (6, 0, 0), 'lowerArm_L': (-40, 0, -10), 'lowerArm_R': (-40, 0, 10)})
EAT_UP = merge(SIT, {'upperArm_R': (-56, -14, 0), 'lowerArm_R': (-118, 0, 24), 'hand_R': (-20, 0, 0), 'head': (10, 0, 0), 'neck': (6, 0, 0)})
STIFF = merge(bc.STAND, {'spine': (0, 0, 0), 'neck': (0, 0, 0), 'head': (0, 12, 0),
                         'upperArm_L': (0, 2, 0), 'upperArm_R': (0, -2, 0), 'lowerArm_L': (0, 0, 0), 'lowerArm_R': (0, 0, 0)})

CIV_CLIPS = {
    # 坐著等：雙手放在桌上，偶爾看看四周、手指敲桌
    'SitWait': clip(150, [
        (0, SIT),
        (40, merge(SIT, {'head': (2, 0, 16)})),
        (70, merge(SIT, {'head': (2, 0, 16), 'hand_R': (-18, 0, 0)})),
        (76, merge(SIT, {'head': (2, 0, 16), 'hand_R': (0, 0, 0)})),
        (82, merge(SIT, {'head': (2, 0, 14), 'hand_R': (-18, 0, 0)})),
        (110, merge(SIT_HANDS_LAP, {'head': (6, 0, -10)})),
    ], True),
    # 坐著吃：右手一口一口送到嘴邊
    'SitEat': clip(60, [(0, SIT), (18, EAT_UP), (30, EAT_UP), (48, SIT)], True),
    # 神秘客人：坐著，一動也不動（只有非常輕微的呼吸）
    'SitStill': clip(200, [(0, SIT_HANDS_LAP), (100, merge(SIT_HANDS_LAP, {'chest': (-0.6, 0, 0)}))], True),
    # 神秘客人：僵直地站著，頭歪向一邊
    'StandStiff': clip(200, [(0, STIFF), (100, merge(STIFF, {'chest': (-0.5, 0, 0)}))], True),
}


# ======================================================================================
# 主程式
# ======================================================================================


def export(path, objs, anims):
    bc.export_glb(path, objs, anims)


def main():
    args = sys.argv[1:]
    preview = None
    if '--preview' in args:
        i = args.index('--preview')
        preview = args[i + 1]
        del args[i:i + 2]
    out = args[0] if args else os.path.join(os.path.dirname(__file__), '..', '..', 'client', 'public', 'models')
    os.makedirs(out, exist_ok=True)
    report = {}

    # 怪物（模型＋動畫在同一個檔案）
    bc.reset_scene()
    arm = make_armature_generic('MonsterArmature', MBONES, MJ)
    b = bc.Builder()
    build_monster(b)
    obj = make_mesh_generic('monster', b, monster_materials(), arm, MBONE_NAMES)
    bake(arm, MONSTER_CLIPS)
    export(os.path.join(out, 'monster.glb'), [arm, obj], True)
    report['monster'] = {'triangles': sum(len(f[0]) - 2 for f in b.faces)}
    if preview:
        render(arm, obj, preview, 'monster', MONSTER_CLIPS, height=2.0)

    # 客人
    for name, cfg in list(DINERS.items()) + [('guest_suit', GUEST)]:
        bc.reset_scene()
        arm = bc.make_armature('Armature')
        b = bc.Builder()
        c2 = dict(cfg)
        c2['hair'] = cfg.get('hair_style', 'short')
        c2['skirt'] = bool(cfg.get('skirt'))
        c2['hat'] = bool(cfg.get('hat'))
        c2['jacket'] = bool(cfg.get('jacket'))
        build_civilian(b, c2)
        mats = civilian_materials(name, cfg, creepy=name == 'guest_suit')
        obj = bc.make_mesh(name, b, mats, arm)
        export(os.path.join(out, f'{name}.glb'), [arm, obj], False)
        report[name] = {'triangles': sum(len(f[0]) - 2 for f in b.faces)}
        if preview and name in ('guest_suit', 'diner_a', 'diner_b'):
            bake(arm, CIV_CLIPS)
            render(arm, obj, preview, name, CIV_CLIPS, height=1.4)

    # 客人的動畫庫
    bc.reset_scene()
    arm = bc.make_armature('Armature')
    b = bc.Builder()
    w = {'hips': 1}
    b.face([b.vert((0, 0, 0.9), w), b.vert((0.001, 0, 0.9), w), b.vert((0, 0.001, 0.9), w)], [(0, 0), (1, 0), (0, 1)], 'x')
    dummy = bc.make_mesh('civ_dummy', b, {'x': bpy.data.materials.new('civ_dummy')}, arm)
    bake(arm, CIV_CLIPS)
    export(os.path.join(out, 'civ_anims.glb'), [arm, dummy], True)

    with open(os.path.join(out, 'creatures.json'), 'w', encoding='utf-8') as f:
        json.dump({
            'generator': 'tools/characters/build_creatures.py',
            'monster': {'model': 'monster.glb', 'clips': {k: {'frames': c['length'], 'loop': c['loop']} for k, c in MONSTER_CLIPS.items()}},
            'guest': {'model': 'guest_suit.glb'},
            'diners': [f'{n}.glb' for n in DINERS],
            'civAnims': 'civ_anims.glb',
            'civClips': {k: {'frames': c['length'], 'loop': c['loop']} for k, c in CIV_CLIPS.items()},
            'stats': report,
        }, f, ensure_ascii=False, indent=2)
    print('[creatures] 完成', json.dumps(report))


def render(arm, obj, folder, name, clips, height=1.7):
    """預覽：每個動畫取一格（Cycles CPU）"""
    os.makedirs(folder, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 10
    sc.cycles.device = 'CPU'
    sc.render.resolution_x = 320
    sc.render.resolution_y = 400
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.12, 0.13, 0.13, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.7
    sc.world = world
    for e, rot in ((4.0, (50, 10, -30)), (1.4, (70, 0, 160))):
        l = bpy.data.objects.new('l', bpy.data.lights.new('l', 'SUN'))
        l.data.energy = e
        l.rotation_euler = tuple(math.radians(a) for a in rot)
        sc.collection.objects.link(l)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.lens = 40
    sc.collection.objects.link(cam)
    sc.camera = cam
    dist = 3.6 if height > 1.6 else 3.0
    for clip_name, c in clips.items():
        act = bpy.data.actions.get(clip_name)
        arm.animation_data.action = act
        frame = c['keys'][min(1, len(c['keys']) - 1)][0] + 1
        sc.frame_set(frame)
        for view, (x, y, rz) in {'34': (dist * 0.6, -dist * 0.8, 37)}.items():
            cam.location = (x, y, height * 0.6)
            cam.rotation_euler = (math.radians(86), 0, math.radians(rz))
            sc.render.filepath = os.path.join(folder, f'{name}_{clip_name}_{view}.png')
            bpy.ops.render.render(write_still=True)
    arm.animation_data.action = None


if __name__ == '__main__':
    main()
