"""Validate evidence for a modeling review. This does not score visual likeness."""

import json
from pathlib import Path
import re
import runpy

contract = runpy.run_path(str(Path(__file__).with_name('exchange.py')))
REQUIRED_VIEWS = {'front', 'right', 'rear', 'left', 'three-quarter'}


def evidence(root, item):
    path = (root / item['path']).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError('Review evidence must be a file inside this exchange')
    if contract['digest'](path) != item['sha256']:
        raise ValueError(f'Review evidence changed: {item["path"]}')
    return path


def load_plan(root):
    root = Path(root).resolve()
    plan = json.loads((root / 'quality-plan.json').read_text(encoding='utf-8'))
    if plan.get('version') != 1 or not str(plan.get('subject', '')).strip():
        raise ValueError('Quality plan needs a version and subject')
    features = plan.get('features', [])
    ids = [item['id'] for item in features]
    if not ids or len(set(ids)) != len(ids) or not any(item.get('critical') is True for item in features):
        raise ValueError('List distinct features, including the identity-defining critical features')
    for item in features:
        if (not item.get('description') or not item.get('construction')
                or item.get('basis') not in {'observed', 'inferred', 'requested'}):
            raise ValueError('Each feature needs a description, construction method and evidence basis')
    views = plan.get('views', [])
    view_ids = [item['id'] for item in views]
    required = REQUIRED_VIEWS | ({'reference'} if plan.get('references') else set())
    if (not required.issubset(view_ids) or len(set(view_ids)) != len(view_ids)
            or any(not re.fullmatch(r'[a-z][a-z0-9-]*', name) for name in view_ids)):
        raise ValueError('Quality plan needs distinct front/right/rear/left/three-quarter views and a reference view for photos')
    for item in views:
        if (type(item.get('azimuth')) not in {int, float} or not -360 <= item['azimuth'] <= 360
                or type(item.get('elevation')) not in {int, float} or not -85 <= item['elevation'] <= 85):
            raise ValueError('Each review view needs finite azimuth and elevation angles')
    cameras = {item['id']: item for item in views}
    front = cameras['front']['azimuth']
    for name, offset in [('front', 0), ('right', 90), ('rear', 180), ('left', 270)]:
        difference = (cameras[name]['azimuth'] - front - offset + 180) % 360 - 180
        if abs(difference) > 0.001 or abs(cameras[name]['elevation']) > 0.001:
            raise ValueError('The four cardinal review cameras must orbit at 90-degree intervals')
    oblique = cameras['three-quarter']
    difference = abs((oblique['azimuth'] - front + 180) % 360 - 180)
    if not 10 <= difference <= 80 or abs(oblique['elevation']) < 10:
        raise ValueError('The three-quarter camera must reveal depth and height')
    if plan.get('surface') not in {'closed', 'open'}:
        raise ValueError('Declare whether this subject intentionally has an open surface')
    for key, minimum in [('max_triangles', 1), ('min_uv_sets', 0)]:
        if type(plan.get(key)) is not int or plan[key] < minimum:
            raise ValueError(f'Quality plan needs a valid {key}')
    for item in plan.get('references', []):
        evidence(root, item)
    return plan


def validate_review(root, exported):
    root = Path(root).resolve()
    plan_hash = exported.get('quality_plan_sha256')
    if not plan_hash and not (root / 'quality-plan.json').exists():
        return {'status': 'not_requested'}
    plan = load_plan(root)
    if plan_hash != contract['digest'](root / 'quality-plan.json'):
        raise ValueError('Quality plan changed or was added after export; export and review again')
    if exported.get('blend_sha256') != contract['digest'](root / 'work.blend'):
        raise ValueError('Blender source changed after export; export and review again')
    if exported['triangles'] > plan['max_triangles']:
        raise ValueError('Model exceeds the agreed triangle budget')
    geometry = exported.get('geometry', {})
    for key in ['boundary_edges', 'non_manifold_edges', 'wire_edges', 'zero_area_faces', 'uv_sets']:
        if type(geometry.get(key)) is not int or geometry[key] < 0:
            raise ValueError('Export has no complete geometry inspection')
    if any(geometry[key] for key in ['non_manifold_edges', 'wire_edges', 'zero_area_faces']):
        raise ValueError('Geometry contains non-manifold edges, loose edges or zero-area faces')
    if plan['surface'] == 'closed' and geometry['boundary_edges']:
        raise ValueError('Expected a closed surface, but the mesh has open boundaries')
    if geometry['uv_sets'] < plan['min_uv_sets']:
        raise ValueError('Required UV layers are missing')
    review = json.loads((root / 'quality-review.json').read_text(encoding='utf-8'))
    captures_path = root / 'quality-captures.json'
    captures = json.loads(captures_path.read_text(encoding='utf-8'))
    bindings = {'plan_sha256': plan_hash, 'export_sha256': exported['sha256'],
                'blend_sha256': contract['digest'](root / 'work.blend')}
    if any(record.get(key) != value for record in [review, captures] for key, value in bindings.items()):
        raise ValueError('Review or captures are stale; save, export, capture and inspect the current model')
    if review.get('captures_sha256') != contract['digest'](captures_path):
        raise ValueError('Captures changed after the visual review')
    if contract['digest'](root / 'edited.fbx') != exported['sha256']:
        raise ValueError('Export changed after the visual review')
    required = {item['id'] for item in plan['views']}
    images = captures.get('views', {})
    if not required.issubset(images):
        raise ValueError('Review is missing required camera views')
    for key in required:
        planned = next(item for item in plan['views'] if item['id'] == key)
        if any(images[key].get(field) != planned[field] for field in ['azimuth', 'elevation']):
            raise ValueError(f'Review camera does not match the plan: {key}')
        path = evidence(root, images[key])
        if path.read_bytes()[:8] != b'\x89PNG\r\n\x1a\n':
            raise ValueError('Review capture is not a PNG image')
    checked = review.get('features', {})
    for feature in plan['features']:
        verdict = checked.get(feature['id'], {})
        if (verdict.get('status') != 'pass' or not str(verdict.get('observation', '')).strip()
                or not verdict.get('views') or not set(verdict['views']).issubset(required)):
            raise ValueError(f'Feature is not verified: {feature["id"]}; a global score cannot override it')
    if review.get('decision') != 'pass':
        raise ValueError('The visual review has not passed')
    return {'status': 'passed', 'features': len(checked), 'views': len(required),
            'scope': 'Evidence freshness and recorded review; visual judgment remains with the reviewer'}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('exchange_directory')
    args = parser.parse_args()
    try:
        directory = contract['directory'](args.exchange_directory)
        report = json.loads((directory / 'export.json').read_text(encoding='utf-8'))
        print(json.dumps(validate_review(directory, report), ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f'Quality review blocked: {error}\n')
