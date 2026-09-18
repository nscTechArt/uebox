"""Run: python -m unittest discover -s tests -p test_blender_dcc_exchange.py"""

import json
from pathlib import Path
import runpy
import tempfile
import unittest

contract = runpy.run_path(str(Path(__file__).resolve().parents[1] /
                             'resources/skills/blender-ue-pipeline/scripts/exchange.py'))


class ExchangeContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest = {
            'version': 1, 'id': 'a' * 32, 'revision': 0,
            'project_file': str(self.root / 'Test.uproject'),
            'source_asset': '/Game/Props/SM_Crate', 'target_asset': '/Game/Props/SM_Crate_DCC',
            'materials': [{'slot': 'Wood'}]
        }
        contract['write_json'](self.root / 'manifest.json', self.manifest)
        (self.root / 'edited.fbx').write_bytes(b'fixture FBX bytes')
        self.report = {
            'exchange_id': self.manifest['id'], 'triangles': 120, 'material_count': 1,
            'material_triangles': {'0': 120},
            'sha256': contract['digest'](self.root / 'edited.fbx')
        }
        self.save_report()

    def save_report(self):
        contract['write_json'](self.root / 'export.json', self.report)

    def test_valid_pair_round_trips_unicode_and_retains_identity(self):
        self.manifest['label'] = '建筑道具'
        contract['write_json'](self.root / 'manifest.json', self.manifest)
        root, value = contract['load'](str(self.root))
        self.assertEqual(root, self.root.resolve())
        self.assertEqual(value['label'], '建筑道具')
        self.assertEqual(contract['verify_export'](root, value), self.report)
        self.assertFalse((root / 'manifest.json.tmp').exists())

    def test_source_cannot_be_return_target(self):
        self.manifest['target_asset'] = self.manifest['source_asset']
        contract['write_json'](self.root / 'manifest.json', self.manifest)
        with self.assertRaisesRegex(ValueError, 'original'):
            contract['load'](self.root)

    def test_rejects_traversal_engine_and_object_paths(self):
        for value in ['/Engine/Cube', '/Game/../Other', '/Game/A.A', '/Game//A', 'C:/A', '/Game/A\\B']:
            with self.subTest(path=value), self.assertRaises(ValueError):
                contract['asset_path'](value)

    def test_unknown_version_and_negative_revision(self):
        for key, value in [('version', 2), ('revision', -1), ('revision', True), ('id', '../x')]:
            with self.subTest(key=key):
                invalid = {**self.manifest, key: value}
                contract['write_json'](self.root / 'manifest.json', invalid)
                with self.assertRaises(ValueError):
                    contract['load'](self.root)

    def test_changed_export_is_not_trusted(self):
        (self.root / 'edited.fbx').write_bytes(b'replaced after validation')
        with self.assertRaisesRegex(ValueError, 'changed after export'):
            contract['verify_export'](self.root, self.manifest)

    def test_different_exchange_cannot_return(self):
        self.report['exchange_id'] = 'b' * 32
        self.save_report()
        with self.assertRaisesRegex(ValueError, 'different exchange'):
            contract['verify_export'](self.root, self.manifest)

    def test_empty_geometry_and_changed_material_slots_fail(self):
        for key, value in [('triangles', 0), ('triangles', True), ('material_count', 2)]:
            with self.subTest(key=key):
                altered = {**self.report, key: value}
                contract['write_json'](self.root / 'export.json', altered)
                with self.assertRaises(ValueError):
                    contract['verify_export'](self.root, self.manifest)

    def test_bounds_allow_rounding_but_reject_scale_axis_and_nonfinite(self):
        bounds = [-60, -40, -100, 60, 40, 100]
        contract['check_bounds'](bounds, [-60.001, -40, -100, 60, 40, 100])
        for actual in [[v * 100 for v in bounds], [-40, -60, -100, 40, 60, 100],
                       [float('nan'), *bounds[1:]], bounds[:3]]:
            with self.subTest(bounds=actual), self.assertRaises(ValueError):
                contract['check_bounds'](bounds, actual)

    def test_rejects_relative_exchange_directory(self):
        with self.assertRaisesRegex(ValueError, 'absolute'):
            contract['directory']('relative/SourceArt')

    def test_incomplete_or_invalid_material_face_report_fails(self):
        for faces in [{}, {'0': 119}, {'0': -1}, {'0': True}, {'1': 120}, None]:
            with self.subTest(faces=faces):
                contract['write_json'](self.root / 'export.json', {**self.report, 'material_triangles': faces})
                with self.assertRaisesRegex(ValueError, 'per-material'):
                    contract['verify_export'](self.root, self.manifest)


if __name__ == '__main__':
    unittest.main()
