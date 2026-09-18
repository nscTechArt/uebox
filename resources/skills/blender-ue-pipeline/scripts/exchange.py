"""File contract shared by the Blender and Unreal sides of one static-mesh exchange."""

import hashlib
import json
import math
import os
from pathlib import Path
import re
import runpy


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def asset_path(value):
    if not isinstance(value, str) or not re.fullmatch(r'/Game/(?:[\w-]+/)*[\w-]+', value):
        raise ValueError('Expected a /Game/... package path, without an object suffix')
    return value


def directory(value):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError('Exchange directory must be an absolute local path')
    return path.resolve()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def load(directory_path):
    root = directory(directory_path)
    value = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    if value.get('version') != 1 or not re.fullmatch(r'[a-f0-9]{32}', str(value.get('id', ''))):
        raise ValueError('Unsupported or malformed exchange manifest')
    asset_path(value['source_asset'])
    asset_path(value['target_asset'])
    if value['source_asset'] == value['target_asset']:
        raise ValueError('First-version exchange keeps the source asset as the original')
    if not Path(value['project_file']).is_absolute():
        raise ValueError('Manifest has no absolute UE project path')
    if type(value['revision']) is not int or value['revision'] < 0:
        raise ValueError('Invalid exchange revision')
    if not value['materials']:
        raise ValueError('A static prop must have at least one material slot')
    return root, value


def check_bounds(expected, actual, tolerance_cm=0.1):
    """1 mm tolerance catches unit/axis mistakes without rejecting FBX float rounding."""
    if len(expected) != 6 or len(actual) != 6:
        raise ValueError('Bounds must contain local minimum and maximum XYZ')
    if not all(math.isfinite(n) for n in [*expected, *actual]):
        raise ValueError('Mesh bounds contain non-finite values')
    if any(abs(a - b) > tolerance_cm for a, b in zip(expected, actual)):
        raise ValueError(f'Local bounds changed: expected {expected}, got {actual}')


def verify_export(root, manifest):
    report = json.loads((root / 'export.json').read_text(encoding='utf-8'))
    if report.get('exchange_id') != manifest['id']:
        raise ValueError('Export belongs to a different exchange')
    if report.get('sha256') != digest(root / 'edited.fbx'):
        raise ValueError('FBX changed after export; export it again before returning to UE')
    if type(report.get('triangles')) is not int or report['triangles'] <= 0:
        raise ValueError('Export has no triangles')
    if report.get('material_count') != len(manifest['materials']):
        raise ValueError('Material slot count changed; this exchange preserves the original slots')
    faces = report.get('material_triangles', {})
    if (not isinstance(faces, dict) or set(faces) != {str(i) for i in range(len(manifest['materials']))}
            or any(type(n) is not int or n < 0 for n in faces.values())
            or sum(faces.values()) != report['triangles']):
        raise ValueError('Export has no complete per-material triangle report')
    if report.get('quality_plan_sha256') or (root / 'quality-plan.json').exists():
        runpy.run_path(str(Path(__file__).with_name('quality_review.py')))['validate_review'](root, report)
    return report
