"""Run inside Unreal Editor via ue_run_python_script. One static prop, source LOD 0."""

from pathlib import Path
import re
import runpy
import uuid

contract = runpy.run_path(str(Path(__file__).with_name('exchange.py')))


def _project():
    import unreal
    return Path(unreal.Paths.get_project_file_path()).resolve()


def _package_file(package):
    return _project().parent / 'Content' / (contract['asset_path'](package)[6:] + '.uasset')


def _clean_asset(package):
    import unreal
    if any(p.get_path_name() == package for p in unreal.EditorLoadingAndSavingUtils.get_dirty_content_packages()):
        raise RuntimeError(f'Save the intended asset before exchange: {package}')
    asset = unreal.load_asset(package)
    if not isinstance(asset, unreal.StaticMesh):
        raise RuntimeError(f'Expected a static mesh: {package}')
    return asset


def _read(asset):
    import unreal
    lod = unreal.GeometryScriptMeshReadLOD()
    lod.lod_type = unreal.GeometryScriptLODType.SOURCE_MODEL
    lod.lod_index = 0
    mesh, outcome = unreal.GeometryScript_AssetUtils.copy_mesh_from_static_mesh_v2(
        asset, unreal.DynamicMesh(), unreal.GeometryScriptCopyMeshFromAssetOptions(), lod,
        use_section_materials=False)
    if outcome != unreal.GeometryScriptOutcomePins.SUCCESS or not mesh.get_triangle_count():
        raise RuntimeError('Unable to read nonempty source LOD 0')
    return mesh


def _bounds(mesh):
    import unreal
    box = unreal.GeometryScript_MeshQueries.get_mesh_bounding_box(mesh)
    return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]


def _materials(asset):
    return [{'slot': str(s.material_slot_name),
             'material': s.material_interface.get_path_name() if s.material_interface else None,
             'material_name': s.material_interface.get_name() if s.material_interface else ''}
            for s in asset.static_materials]


def _material_triangles(mesh, count):
    import unreal
    _, values, has_ids = unreal.GeometryScript_Materials.get_all_triangle_material_i_ds(mesh)
    if not has_ids:
        raise RuntimeError('Returned mesh has no face material IDs')
    result = {str(i): 0 for i in range(count)}
    for value in unreal.GeometryScript_List.convert_index_list_to_array(values):
        if str(value) not in result:
            raise RuntimeError('A triangle references an unmapped UE material')
        result[str(value)] += 1
    return result


def _save(asset):
    import unreal
    if not unreal.EditorAssetLibrary.save_loaded_asset(asset, False):
        raise RuntimeError(f'Could not save {asset.get_path_name()}')


def _write(mesh, asset):
    import unreal
    options = unreal.GeometryScriptCopyMeshToAssetOptions()
    options.enable_recompute_normals = False
    options.enable_recompute_tangents = True
    options.use_build_scale = True
    _, outcome = unreal.GeometryScript_AssetUtils.copy_mesh_to_static_mesh(
        mesh, asset, options, unreal.GeometryScriptMeshWriteLOD(), use_section_materials=False)
    if outcome != unreal.GeometryScriptOutcomePins.SUCCESS:
        raise RuntimeError('Could not write geometry to the target static mesh')


def send_asset(source_asset, target_asset, directory_path=None):
    """Export an original. The first return creates target_asset; later returns update it."""
    import unreal
    source_asset = contract['asset_path'](source_asset)
    target_asset = contract['asset_path'](target_asset)
    if source_asset == target_asset or unreal.EditorAssetLibrary.does_asset_exist(target_asset):
        raise RuntimeError('Choose a new /Game target; retain the original as the source')
    source = _clean_asset(source_asset)
    if unreal.GeometryScript_AssetUtils.get_num_static_mesh_lo_ds_of_type(
            source, unreal.GeometryScriptLODType.SOURCE_MODEL) != 1:
        raise RuntimeError('First-version exchange supports one source LOD; existing LOD chains need separate handling')
    materials = _materials(source)
    if not materials or any(not item['material'] for item in materials):
        raise RuntimeError('Assign a material to every source slot before sending')
    if len({m['material_name'] for m in materials}) != len(materials):
        raise RuntimeError('Repeated material names cannot be mapped unambiguously through FBX')
    mesh = _read(source)
    exchange_id = uuid.uuid4().hex
    root = contract['directory'](directory_path) if directory_path else _project().parent / 'SourceArt' / 'UnrealBox' / exchange_id
    root.mkdir(parents=True, exist_ok=False)
    task = unreal.AssetExportTask()
    task.object = source
    task.filename = str(root / 'source.fbx')
    task.automated = True
    task.prompt = False
    task.replace_identical = False
    task.exporter = unreal.StaticMeshExporterFBX()
    options = unreal.FbxExportOption()
    options.collision = False
    options.level_of_detail = False
    options.export_source_mesh = True
    task.options = options
    if not unreal.Exporter.run_asset_export_task(task) or not (root / 'source.fbx').is_file():
        raise RuntimeError(f'FBX export failed; inspect {root}')
    manifest = {'version': 1, 'id': exchange_id, 'project_file': str(_project()),
                'source_asset': source_asset, 'target_asset': target_asset, 'revision': 0,
                'source_sha256': contract['digest'](_package_file(source_asset)),
                'source_fbx_sha256': contract['digest'](root / 'source.fbx'),
                'target_sha256': None, 'applied_export_sha256': None,
                'materials': materials, 'bounds_cm': _bounds(mesh),
                'source_triangles': mesh.get_triangle_count()}
    contract['write_json'](root / 'manifest.json', manifest)
    return {'directory': str(root), **manifest}


def _stage(root, manifest):
    import unreal
    task = unreal.AssetImportTask()
    task.filename = str(root / 'edited.fbx')
    task.destination_path = '/Game/__DccStaging/' + manifest['id']
    task.destination_name = 'Revision_' + str(manifest['revision'] + 1)
    if unreal.EditorAssetLibrary.does_asset_exist(task.destination_path + '/' + task.destination_name):
        raise RuntimeError('A previous staging asset exists; inspect it before retrying the return')
    task.automated = True
    task.replace_existing = False
    task.save = False
    task.factory = unreal.FbxFactory()
    options = unreal.FbxImportUI()
    options.automated_import_should_detect_type = False
    options.mesh_type_to_import = unreal.FBXImportType.FBXIT_STATIC_MESH
    options.import_mesh = True
    options.import_as_skeletal = False
    options.import_materials = False
    options.import_textures = False
    options.import_animations = False
    options.static_mesh_import_data.combine_meshes = True
    options.static_mesh_import_data.auto_generate_collision = False
    # Keep small bevel faces; FBX's automatic cleanup can discard valid geometry.
    options.static_mesh_import_data.remove_degenerates = False
    options.static_mesh_import_data.generate_lightmap_u_vs = False
    options.static_mesh_import_data.import_mesh_lo_ds = False
    options.static_mesh_import_data.normal_import_method = unreal.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS
    task.options = options
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    imported = [item for item in task.get_objects() if isinstance(item, unreal.StaticMesh)]
    if len(imported) != 1:
        raise RuntimeError('FBX import did not produce exactly one static mesh')
    return imported[0]


def return_asset(directory_path, preserve_bounds=True):
    """Stage and validate before changing the mapped target. Repeated identical returns are no-ops."""
    import unreal
    root, manifest = contract['load'](directory_path)
    if Path(manifest['project_file']).resolve() != _project():
        raise RuntimeError('Exchange belongs to another UE project')
    report = contract['verify_export'](root, manifest)
    source = _clean_asset(manifest['source_asset'])
    if contract['digest'](_package_file(manifest['source_asset'])) != manifest['source_sha256']:
        raise RuntimeError('The source asset changed since sending; start a new exchange')
    target = None
    if manifest['revision']:
        target = _clean_asset(manifest['target_asset'])
        if contract['digest'](_package_file(manifest['target_asset'])) != manifest['target_sha256']:
            raise RuntimeError('Target changed outside this exchange; inspect before returning')
        if report['sha256'] == manifest['applied_export_sha256']:
            return {'status': 'unchanged', 'target_asset': manifest['target_asset'], 'revision': manifest['revision']}
    elif unreal.EditorAssetLibrary.does_asset_exist(manifest['target_asset']):
        raise RuntimeError('Target exists but is not recorded as applied; inspect instead of overwriting')
    staged = _stage(root, manifest)
    mesh = _read(staged)
    if mesh.get_triangle_count() != report['triangles']:
        raise RuntimeError(f"Triangle count changed during import: {report['triangles']} -> {mesh.get_triangle_count()}; inspect {staged.get_path_name()}")
    if preserve_bounds:
        contract['check_bounds'](manifest['bounds_cm'], _bounds(mesh))
    slots = list(staged.static_materials)
    mapping = []
    for slot in slots:
        name = str(slot.material_slot_name)
        match = re.fullmatch(r'UBX_SLOT_(\d{3})', name)
        if not match or int(match[1]) >= len(manifest['materials']):
            raise RuntimeError(f'Unmapped material slot in returned FBX: {name}')
        mapping.append(int(match[1]))
    if len(set(mapping)) != len(mapping):
        raise RuntimeError('Duplicate material slot identity in returned FBX')
    # Two passes prevent swaps such as 0 -> 1 -> 0 from collapsing two materials into one.
    for i in range(len(mapping)):
        unreal.GeometryScript_Materials.remap_material_i_ds(mesh, i, i + len(mapping))
    for i, destination in enumerate(mapping):
        unreal.GeometryScript_Materials.remap_material_i_ds(mesh, i + len(mapping), destination)
    expected_material_faces = report['material_triangles']
    if _material_triangles(mesh, len(manifest['materials'])) != expected_material_faces:
        raise RuntimeError('Face material assignments changed during import')
    before = _read(target) if target else None
    if not target:
        target = unreal.EditorAssetLibrary.duplicate_asset(manifest['source_asset'], manifest['target_asset'])
        if not target:
            raise RuntimeError('Could not create the return copy')
    try:
        _write(mesh, target)
        checked = _read(target)
        contract['check_bounds'](_bounds(mesh), _bounds(checked))
        if checked.get_triangle_count() != report['triangles'] or _materials(target) != manifest['materials']:
            raise RuntimeError('Returned geometry or original material slots did not survive readback')
        if _material_triangles(checked, len(manifest['materials'])) != expected_material_faces:
            raise RuntimeError('Face material assignments changed during target readback')
        _save(target)
    except Exception:
        if before:
            _write(before, target)
            _save(target)
        # On first-return failure keep the copy for inspection; never delete a user-facing asset.
        raise
    manifest['revision'] += 1
    manifest['target_sha256'] = contract['digest'](_package_file(manifest['target_asset']))
    manifest['applied_export_sha256'] = report['sha256']
    try:
        contract['write_json'](root / 'manifest.json', manifest)
    except OSError as error:
        raise RuntimeError('Target was saved, but its exchange revision could not be recorded; inspect before retrying') from error
    return {'status': 'applied', 'target_asset': manifest['target_asset'],
            'original_asset': manifest['source_asset'], 'revision': manifest['revision'],
            'triangles': checked.get_triangle_count(), 'bounds_cm': _bounds(checked),
            'materials_preserved': True, 'material_triangles': expected_material_faces,
            'collision': 'Original collision retained; shape suitability must be checked',
            'staging_asset': staged.get_path_name(), 'blend_file': str(root / 'work.blend')}
