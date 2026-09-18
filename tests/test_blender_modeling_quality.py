"""Run with python -B -m unittest discover -s tests -p test_blender*.py."""

import base64
import json
from pathlib import Path
import runpy
import tempfile
import unittest

skill = Path(__file__).resolve().parents[1] / 'resources/skills/blender-ue-pipeline'
quality = runpy.run_path(str(skill / 'scripts/quality_review.py'))
contract = quality['contract']
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=')


class ModelingQualityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.plan = json.loads((skill / 'assets/quality-plan.example.json').read_text(encoding='utf-8'))
        self.write('quality-plan.json', self.plan)
        (self.root / 'work.blend').write_bytes(b'model revision one')
        (self.root / 'edited.fbx').write_bytes(b'export revision one')
        self.manifest = {'id': 'a' * 32, 'materials': [{}, {}]}
        self.exported = {'exchange_id': self.manifest['id'], 'triangles': 432, 'material_count': 2,
                         'material_triangles': {'0': 216, '1': 216},
                         'sha256': self.hash('edited.fbx'), 'blend_sha256': self.hash('work.blend'),
                         'quality_plan_sha256': self.hash('quality-plan.json'),
                         'geometry': {'boundary_edges': 0, 'non_manifold_edges': 0, 'wire_edges': 0,
                                      'zero_area_faces': 0, 'uv_sets': 2}}
        bindings = {'plan_sha256': self.exported['quality_plan_sha256'],
                    'blend_sha256': self.hash('work.blend'), 'export_sha256': self.hash('edited.fbx')}
        self.captures = {**bindings, 'views': {}}
        for view in self.plan['views']:
            name = view['id'] + '.png'
            (self.root / name).write_bytes(PNG)
            self.captures['views'][view['id']] = {'path': name, 'sha256': self.hash(name),
                                                 'azimuth': view['azimuth'], 'elevation': view['elevation']}
        self.write('quality-captures.json', self.captures)
        self.review = {**bindings, 'captures_sha256': self.hash('quality-captures.json'),
                       'decision': 'pass', 'features': {}}
        for feature in self.plan['features']:
            self.review['features'][feature['id']] = {'status': 'pass', 'observation': 'Unit-test review fixture',
                                                     'views': ['front', 'three-quarter']}
        self.write('quality-review.json', self.review)
        self.write('export.json', self.exported)

    def hash(self, filename):
        return contract['digest'](self.root / filename)

    def write(self, filename, value):
        contract['write_json'](self.root / filename, value)

    def check(self):
        self.write('export.json', self.exported)
        return contract['verify_export'](self.root, self.manifest)

    def test_current_complete_review_passes_the_real_return_contract(self):
        self.assertEqual(self.check(), self.exported)

    def test_global_score_cannot_override_a_missing_critical_feature(self):
        self.review['global_score'] = 0.99
        self.review['features']['edge-profile']['status'] = 'fail'
        self.write('quality-review.json', self.review)
        with self.assertRaisesRegex(ValueError, 'Feature is not verified: edge-profile'):
            self.check()

    def test_changed_blender_source_cannot_use_old_export_or_newer_captures(self):
        (self.root / 'work.blend').write_bytes(b'new model, old FBX')
        self.review['blend_sha256'] = self.captures['blend_sha256'] = self.hash('work.blend')
        self.write('quality-captures.json', self.captures)
        self.review['captures_sha256'] = self.hash('quality-captures.json')
        self.write('quality-review.json', self.review)
        with self.assertRaisesRegex(ValueError, 'source changed after export'):
            self.check()

    def test_changed_screenshot_requires_reinspection(self):
        (self.root / 'rear.png').write_bytes(PNG + b'changed')
        with self.assertRaisesRegex(ValueError, 'evidence changed'):
            self.check()

    def test_missing_rear_view_is_not_accepted(self):
        del self.captures['views']['rear']
        self.write('quality-captures.json', self.captures)
        self.review['captures_sha256'] = self.hash('quality-captures.json')
        self.write('quality-review.json', self.review)
        with self.assertRaisesRegex(ValueError, 'missing required camera views'):
            self.check()

    def test_changed_or_removed_plan_cannot_disable_exported_quality_requirement(self):
        self.plan['features'][1]['description'] = 'A different edge profile'
        self.write('quality-plan.json', self.plan)
        with self.assertRaisesRegex(ValueError, 'Quality plan changed'):
            self.check()
        (self.root / 'quality-plan.json').unlink()
        with self.assertRaises(FileNotFoundError):
            self.check()

    def test_geometry_and_budget_fail_before_visual_acceptance(self):
        for key in ['boundary_edges', 'non_manifold_edges', 'wire_edges', 'zero_area_faces']:
            with self.subTest(key=key):
                self.exported['geometry'][key] = 1
                with self.assertRaises(ValueError):
                    self.check()
                self.exported['geometry'][key] = 0
        self.exported['geometry']['uv_sets'] = 1
        with self.assertRaisesRegex(ValueError, 'UV layers'):
            self.check()
        self.exported['geometry']['uv_sets'] = 2
        self.plan['max_triangles'] = 400
        self.write('quality-plan.json', self.plan)
        self.exported['quality_plan_sha256'] = self.hash('quality-plan.json')
        with self.assertRaisesRegex(ValueError, 'triangle budget'):
            self.check()

    def test_declared_open_surface_can_pass_without_hiding_other_defects(self):
        self.plan['surface'] = 'open'
        self.write('quality-plan.json', self.plan)
        plan_hash = self.hash('quality-plan.json')
        self.exported['quality_plan_sha256'] = plan_hash
        self.captures['plan_sha256'] = self.review['plan_sha256'] = plan_hash
        self.write('quality-captures.json', self.captures)
        self.review['captures_sha256'] = self.hash('quality-captures.json')
        self.write('quality-review.json', self.review)
        self.exported['geometry']['boundary_edges'] = 4
        self.assertEqual(self.check()['geometry']['boundary_edges'], 4)

    def test_export_from_another_revision_is_not_reviewed(self):
        self.captures['export_sha256'] = '0' * 64
        self.write('quality-captures.json', self.captures)
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.check()

    def test_photo_requires_a_reference_view_and_unchanged_local_reference(self):
        self.plan['references'] = [{'path': 'front.png', 'sha256': self.hash('front.png')}]
        self.write('quality-plan.json', self.plan)
        with self.assertRaisesRegex(ValueError, 'reference view for photos'):
            quality['load_plan'](self.root)
        self.plan['views'].append({'id': 'reference', 'azimuth': 20, 'elevation': 10})
        self.write('quality-plan.json', self.plan)
        self.assertEqual(len(quality['load_plan'](self.root)['references']), 1)
        (self.root / 'front.png').write_bytes(b'replaced reference')
        with self.assertRaisesRegex(ValueError, 'evidence changed'):
            quality['load_plan'](self.root)

    def test_review_evidence_cannot_escape_the_exchange(self):
        self.captures['views']['front']['path'] = '../outside.png'
        self.write('quality-captures.json', self.captures)
        self.review['captures_sha256'] = self.hash('quality-captures.json')
        self.write('quality-review.json', self.review)
        with self.assertRaisesRegex(ValueError, 'inside this exchange'):
            self.check()

    def test_unreadable_and_incomplete_evidence_does_not_pass(self):
        (self.root / 'quality-review.json').unlink()
        with self.assertRaises(FileNotFoundError):
            self.check()
        self.review['features']['proportions']['observation'] = ''
        self.write('quality-review.json', self.review)
        with self.assertRaisesRegex(ValueError, 'Feature is not verified'):
            self.check()

    def test_five_labels_cannot_hide_front_only_views(self):
        self.plan['views'][2]['azimuth'] = self.plan['views'][0]['azimuth']
        self.write('quality-plan.json', self.plan)
        with self.assertRaisesRegex(ValueError, '90-degree intervals'):
            quality['load_plan'](self.root)

    def test_capture_camera_must_match_the_review_plan(self):
        self.captures['views']['rear']['azimuth'] = 0
        self.write('quality-captures.json', self.captures)
        self.review['captures_sha256'] = self.hash('quality-captures.json')
        self.write('quality-review.json', self.review)
        with self.assertRaisesRegex(ValueError, 'camera does not match'):
            self.check()


if __name__ == '__main__':
    unittest.main()
