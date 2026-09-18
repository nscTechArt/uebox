"""Run inside Blender via the official MCP execute_blender_code tool."""

from pathlib import Path
import runpy

contract = runpy.run_path(str(Path(__file__).with_name('exchange.py')))


def open_exchange(directory_path):
    import bpy

    root, manifest = contract['load'](directory_path)
    destination = root / 'work.blend'
    if destination.exists():
        raise RuntimeError('work.blend already exists; reopen it instead of importing twice')
    if bpy.data.filepath or bpy.data.is_dirty:
        raise RuntimeError('Use a fresh, separate Blender instance; the current document is in use')
    if contract['digest'](root / 'source.fbx') != manifest['source_fbx_sha256']:
        raise RuntimeError('Source FBX changed after sending from UE')
    bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0
    bpy.ops.import_scene.fbx(filepath=str(root / 'source.fbx'), use_custom_normals=True)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if len(meshes) != 1:
        raise RuntimeError(f'Expected one static mesh; imported {len(meshes)}')
    obj = meshes[0]
    names = [item['material_name'] for item in manifest['materials']]
    if len(set(names)) != len(names):
        raise RuntimeError('Repeated materials cannot be mapped unambiguously in this FBX exchange')
    if len(obj.material_slots) != len(names):
        raise RuntimeError('FBX material count differs from the UE source')
    found = []
    for slot in obj.material_slots:
        name = slot.material.name if slot.material else ''
        if name not in names:
            raise RuntimeError(f'Cannot map imported material {name!r} to a UE slot')
        index = names.index(name)
        found.append(index)
        slot.material.name = f'UBX_SLOT_{index:03d}'
    if sorted(found) != list(range(len(names))):
        raise RuntimeError('Imported material mapping is incomplete')
    # UE FBX can encode centimeters as an object scale of 0.01. Normalize the
    # newly imported object so a 0.04 m bevel means 4 cm in the resulting prop.
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj['unreal_box_exchange'] = manifest['id']
    obj.name = manifest['target_asset'].rsplit('/', 1)[1]
    bpy.ops.wm.save_as_mainfile(filepath=str(destination), check_existing=False)
    return {'exchange_id': manifest['id'], 'object': obj.name,
            'blend_file': str(destination), 'dimensions_m': list(obj.dimensions)}


def export_exchange(directory_path):
    import bmesh
    import bpy

    root, manifest = contract['load'](directory_path)
    if Path(bpy.data.filepath).resolve() != root / 'work.blend':
        raise RuntimeError('The open Blender file is not this exchange work.blend')
    plan_hash = None
    if (root / 'quality-plan.json').exists():
        runpy.run_path(str(Path(__file__).with_name('quality_review.py')))['load_plan'](root)
        plan_hash = contract['digest'](root / 'quality-plan.json')
    meshes = [obj for obj in bpy.context.scene.objects
              if obj.get('unreal_box_exchange') == manifest['id']]
    if len(meshes) != 1 or meshes[0].type != 'MESH':
        raise RuntimeError('Expected exactly one tagged exchange mesh')
    obj = meshes[0]
    if obj.mode != 'OBJECT':
        raise RuntimeError('Finish the current edit and switch to Object Mode before exporting')
    if obj.parent or any(abs(v) > 1e-6 for v in obj.location) or any(abs(v) > 1e-6 for v in obj.rotation_euler):
        raise RuntimeError('Keep the original object origin and rotation; edit its mesh or modifiers')
    if any(v <= 0 for v in obj.scale):
        raise RuntimeError('Negative or zero object scale is not supported')
    expected = {f'UBX_SLOT_{i:03d}' for i in range(len(manifest['materials']))}
    actual = [slot.material.name if slot.material else '' for slot in obj.material_slots]
    if len(actual) != len(expected) or set(actual) != expected:
        raise RuntimeError('Keep the numbered UE material slots; new slots need a separate material workflow')
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        # Match the FBX exporter's triangulation. Loop tessellation alone can
        # count different triangles on bevel n-gons; never edit the source mesh.
        triangulated = bmesh.new()
        try:
            triangulated.from_mesh(mesh)
            bmesh.ops.triangulate(triangulated, faces=triangulated.faces)
            geometry = {'boundary_edges': sum(len(e.link_faces) == 1 for e in triangulated.edges),
                        'non_manifold_edges': sum(len(e.link_faces) > 2 for e in triangulated.edges),
                        'wire_edges': sum(not e.link_faces for e in triangulated.edges),
                        'zero_area_faces': sum(f.calc_area() == 0 for f in triangulated.faces),
                        'uv_sets': len(mesh.uv_layers)}
            triangulated.to_mesh(mesh)
        finally:
            triangulated.free()
        mesh.calc_loop_triangles()
        triangles = len(mesh.loop_triangles)
        if not triangles:
            raise RuntimeError('Cannot export an empty evaluated mesh')
        if any(p.material_index >= len(actual) for p in mesh.polygons):
            raise RuntimeError('A face references a missing material slot')
        material_triangles = {str(i): 0 for i in range(len(actual))}
        for triangle in mesh.loop_triangles:
            slot = int(actual[triangle.material_index].rsplit('_', 1)[1])
            material_triangles[str(slot)] += 1
    finally:
        evaluated.to_mesh_clear()
    selected = list(bpy.context.selected_objects)
    active = bpy.context.view_layer.objects.active
    try:
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.wm.save_as_mainfile(filepath=str(root / 'work.blend'), check_existing=False)
        outcome = bpy.ops.export_scene.fbx(
            filepath=str(root / 'edited.fbx'), check_existing=False, use_selection=True,
            object_types={'MESH'}, use_mesh_modifiers=True, use_triangles=True,
            add_leaf_bones=False, bake_anim=False, axis_forward='-Z', axis_up='Y',
            apply_unit_scale=True, apply_scale_options='FBX_SCALE_NONE', path_mode='STRIP')
        if outcome != {'FINISHED'}:
            raise RuntimeError(f'FBX export did not finish: {outcome}')
    finally:
        bpy.ops.object.select_all(action='DESELECT')
        for item in selected:
            item.select_set(True)
        bpy.context.view_layer.objects.active = active
    report = {'exchange_id': manifest['id'], 'triangles': triangles,
              'blend_sha256': contract['digest'](root / 'work.blend'),
              'geometry': geometry,
              'material_triangles': material_triangles,
              'material_count': len(actual), 'sha256': contract['digest'](root / 'edited.fbx'),
              'blend_file': str(root / 'work.blend'), 'fbx_file': str(root / 'edited.fbx')}
    if plan_hash:
        report['quality_plan_sha256'] = plan_hash
    contract['write_json'](root / 'export.json', report)
    return report
