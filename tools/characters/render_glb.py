"""
匯入一個 .glb，指定動畫與影格，從幾個角度算圖（檢查模型用）。
  python3 tools/characters/render_glb.py 模型.glb 輸出資料夾 [動畫名稱:影格 ...] [--anims 動畫庫.glb] [--size 480x600]
"""
import math
import os
import sys

import bpy
from mathutils import Vector

args = sys.argv[1:]
anim_lib = None
size = (480, 600)
if '--anims' in args:
    i = args.index('--anims'); anim_lib = args[i + 1]; del args[i:i + 2]
if '--size' in args:
    i = args.index('--size'); size = tuple(int(x) for x in args[i + 1].split('x')); del args[i:i + 2]
path, out = args[0], args[1]
shots = args[2:] or ['Idle:10']
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
if anim_lib:
    bpy.ops.import_scene.gltf(filepath=anim_lib)
    for o in list(bpy.context.scene.objects):
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=path)
arm = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE'][0]
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
for m in bpy.data.materials:
    if m.node_tree:
        for n in m.node_tree.nodes:
            if n.type == 'TEX_IMAGE':
                n.interpolation = 'Closest'
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.samples = 16
sc.render.resolution_x, sc.render.resolution_y = size
world = bpy.data.worlds.new('w'); world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.1, 0.11, 0.11, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
sc.world = world
for e, rot in ((3.5, (50, 10, -30)), (1.2, (70, 0, 160))):
    l = bpy.data.objects.new('l', bpy.data.lights.new('l', 'SUN')); l.data.energy = e
    l.rotation_euler = tuple(math.radians(a) for a in rot); sc.collection.objects.link(l)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); cam.data.lens = 50
sc.collection.objects.link(cam); sc.camera = cam
arm.animation_data_create()
views = {'front': (0, -1), 'q': (0.7, -0.7), 'side': (1, 0), 'low': (0, -0.6)}
for shot in shots:
    name, frame = shot.split(':')
    act = bpy.data.actions.get(name)
    if name == 'REST':
        arm.animation_data.action = None
        for pb in arm.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0)
    elif not act:
        print('no action', name, [a.name for a in bpy.data.actions]); continue
    if act:
        arm.animation_data.action = act
    if act and hasattr(arm.animation_data, 'action_slot') and act.slots:
        arm.animation_data.action_slot = act.slots[0]
    sc.frame_set(int(frame))
    bpy.context.view_layer.update()
    pts = []
    dg = bpy.context.evaluated_depsgraph_get()
    for m in meshes:
        ev = m.evaluated_get(dg)
        me = ev.to_mesh()
        pts += [ev.matrix_world @ v.co for v in me.vertices]
        ev.to_mesh_clear()
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    c = (lo + hi) / 2
    r = max((hi.z - lo.z) / 2 * 1.08, (hi.x - lo.x) / 2 * 0.75, 0.5)
    for vn, (dx, dy) in views.items():
        d = r / math.tan(cam.data.angle / 2) * 1.05
        cam.location = c + Vector((dx, dy, -0.5 if vn == 'low' else 0.18)).normalized() * d * (0.45 if vn == 'low' else 1)
        direction = c - cam.location
        cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(out, f'{name}_{frame}_{vn}.png')
        bpy.ops.render.render(write_still=True)
