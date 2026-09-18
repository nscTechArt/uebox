"""Run in a NEW background Blender process, with -- <absolute exchange directory>."""

import json
import math
from pathlib import Path
import runpy
import sys
import uuid


def capture(directory_path):
    import bpy
    from mathutils import Vector

    if not bpy.app.background or bpy.data.filepath or bpy.data.is_dirty:
        raise RuntimeError('Capture in a fresh background Blender process; keep the modeling document untouched')
    helper = runpy.run_path(str(Path(__file__).with_name('quality_review.py')))
    contract = helper['contract']
    root, manifest = contract['load'](directory_path)
    plan = helper['load_plan'](root)
    exported = json.loads((root / 'export.json').read_text(encoding='utf-8'))
    bindings = {'plan_sha256': contract['digest'](root / 'quality-plan.json'),
                'export_sha256': contract['digest'](root / 'edited.fbx'),
                'blend_sha256': contract['digest'](root / 'work.blend')}
    if (exported.get('exchange_id') != manifest['id']
            or exported.get('quality_plan_sha256') != bindings['plan_sha256']
            or exported.get('blend_sha256') != bindings['blend_sha256']
            or exported.get('sha256') != bindings['export_sha256']):
        raise RuntimeError('Save and export the current model and quality plan before capturing')
    # Render the actual delivery mesh. Render-only modifier settings in the
    # editable source must not make the review look better than the exported FBX.
    bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)
    bpy.ops.import_scene.fbx(filepath=str(root / 'edited.fbx'), use_custom_normals=True)
    targets = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if len(targets) != 1:
        raise RuntimeError('Expected one exported mesh for review')
    target = targets[0]
    for obj in bpy.context.scene.objects:
        obj.hide_render = obj != target
    evaluated = target.evaluated_get(bpy.context.evaluated_depsgraph_get())
    corners = [evaluated.matrix_world @ Vector(point) for point in evaluated.bound_box]
    center = sum(corners, Vector()) / len(corners)
    extent = max(max(point[i] for point in corners) - min(point[i] for point in corners) for i in range(3))
    if not math.isfinite(extent) or extent <= 0:
        raise RuntimeError('Cannot frame empty or invalid model bounds')
    scene = bpy.context.scene
    clay = bpy.data.materials.new('Quality_Clay')
    clay.diffuse_color = (0.45, 0.45, 0.45, 1)
    bpy.context.view_layer.material_override = clay
    scene.world = bpy.data.worlds.new('Quality_World')
    scene.world.color = (0.12, 0.12, 0.12)
    for index, offset in enumerate([(-2, -3, 4), (3, -1, 2), (0, 3, 3)]):
        light = bpy.data.lights.new(f'Quality_Light_{index}', 'AREA')
        light.energy = extent * extent * 180
        light.size = extent * 2
        obj = bpy.data.objects.new(light.name, light)
        scene.collection.objects.link(obj)
        obj.location = center + Vector(offset) * extent
        obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data = bpy.data.cameras.new('Quality_Camera')
    camera = bpy.data.objects.new('Quality_Camera', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 16
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    folder = root / 'quality' / uuid.uuid4().hex
    folder.mkdir(parents=True)
    images = {}
    for view in plan['views']:
        azimuth, elevation = math.radians(view['azimuth']), math.radians(view['elevation'])
        direction = Vector((math.sin(azimuth) * math.cos(elevation),
                            -math.cos(azimuth) * math.cos(elevation), math.sin(elevation)))
        camera.location = center + direction * extent * 3
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera_data.type = 'ORTHO'
        camera_data.ortho_scale = extent * 1.65
        scene.render.filepath = str(folder / (view['id'] + '.png'))
        bpy.ops.render.render(write_still=True)
        path = Path(scene.render.filepath)
        images[view['id']] = {'path': path.relative_to(root).as_posix(), 'sha256': contract['digest'](path),
                              'azimuth': view['azimuth'], 'elevation': view['elevation'],
                              'camera_matrix': [list(row) for row in camera.matrix_world], 'render_mode': 'clay'}
    if any(contract['digest'](root / filename) != bindings[key] for filename, key in [
            ('quality-plan.json', 'plan_sha256'), ('edited.fbx', 'export_sha256'), ('work.blend', 'blend_sha256')]):
        raise RuntimeError('Inputs changed during capture; do not review this mixed revision')
    result = {'version': 1, **bindings, 'views': images, 'render_source': 'edited.fbx',
              'scope': 'Orthographic clay geometry views; inspect material response separately in UE'}
    contract['write_json'](root / 'quality-captures.json', result)
    return result


if __name__ == '__main__':
    if '--' not in sys.argv or len(sys.argv[sys.argv.index('--') + 1:]) != 1:
        raise RuntimeError('Supply one absolute exchange directory after --')
    print(json.dumps(capture(sys.argv[-1]), ensure_ascii=False))
