"""Run: python3 -m unittest discover -s tests -p test_blender_mcp_setup.py"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

FILE = Path(__file__).resolve().parents[1] / 'resources/skills/blender-ue-pipeline/scripts/setup_mcp.py'
spec = importlib.util.spec_from_file_location('setup_mcp', FILE)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class MacSetupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.app = self.root / '中文 Blender.app'
        self.exe = self.app / 'Contents/MacOS/Blender'
        self.exe.parent.mkdir(parents=True)
        self.exe.write_text('fixture')
        self.exe.chmod(0o755)
        self.install = self.root / '安装环境'
        self.calls = []
        self.report = 'BLMCP_INSTALLED=True\nBLMCP_ENABLED=True\nBLMCP_ONLINE=False\n'

    def run_command(self, *arguments):
        args = list(map(str, arguments))
        self.calls.append(args)
        if '--version' in args:
            return 'Blender 5.1.0\n'
        if 'rev-parse' in args:
            return setup.REVISION + '\n'
        if 'venv' in args:
            folder = Path(args[-1]) / 'bin'
            folder.mkdir(parents=True)
            (folder / 'python').touch()
            (folder / 'blender-mcp').touch()
        if '--python-expr' in args:
            return self.report
        return ''

    def test_app_path_and_unicode_config(self):
        result = setup.install(self.app, self.install, self.run_command)
        entry = json.loads(result.read_text())['mcpServers']['blender']
        self.assertEqual(entry['env']['BLENDER_PATH'], str(self.exe.resolve()))
        self.assertEqual(entry['command'], str(self.install.resolve() / 'venv/bin/blender-mcp'))
        self.assertTrue(any('mcp[cli]>=1.2,<2' in call for call in self.calls))
        self.assertTrue(any('install-file' in call and '--enable' in call for call in self.calls))

    def test_rerun_repairs_addon_without_downloading(self):
        setup.install(self.exe, self.install, self.run_command)
        self.calls.clear()
        setup.install(self.exe, self.install, self.run_command)
        self.assertFalse(any('fetch' in call or 'pip' in call for call in self.calls))
        self.assertTrue(any('install-file' in call for call in self.calls))

    def test_unknown_directory_is_preserved(self):
        self.install.mkdir()
        marker = self.install / 'user-file'
        marker.write_text('keep')
        with self.assertRaisesRegex(ValueError, 'in use or incomplete'):
            setup.install(self.exe, self.install, self.run_command)
        self.assertEqual(marker.read_text(), 'keep')
        self.assertEqual(len(self.calls), 1)

    def test_failed_install_does_not_write_success_record(self):
        def fail(*args):
            if 'fetch' in args:
                raise OSError('offline')
            return self.run_command(*args)
        with self.assertRaises(OSError):
            setup.install(self.exe, self.install, fail)
        self.assertFalse((self.install / 'installed-revision.txt').exists())
        with self.assertRaisesRegex(ValueError, 'in use or incomplete'):
            setup.install(self.exe, self.install, self.run_command)

    def test_denied_addon_does_not_emit_config(self):
        self.report = 'BLMCP_INSTALLED=True\nBLMCP_ENABLED=False\n'
        with self.assertRaisesRegex(ValueError, 'not enabled'):
            setup.install(self.exe, self.install, self.run_command)
        self.assertFalse((self.install / 'mcp-entry.json').exists())

    def test_old_version_and_nonexecutable_rejected_before_install(self):
        with self.assertRaisesRegex(ValueError, '5.1'):
            setup.install(self.exe, self.install, lambda *args: 'Blender 4.5.0')
        self.assertFalse(self.install.exists())
        self.exe.chmod(0o644)
        with self.assertRaises(ValueError):
            setup.blender_executable(self.app)


if __name__ == '__main__':
    unittest.main()
