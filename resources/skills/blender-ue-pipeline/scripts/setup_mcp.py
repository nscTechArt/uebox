"""Install the pinned official Blender Lab integration on macOS, only on request."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

REVISION = '4309a39646e644261624bfcd2bca669b343b7621'
ORIGIN = 'https://projects.blender.org/lab/blender_mcp.git'
# PyPI first, then two mirrors in mainland China, where PyPI often crawls and a
# stalled read fails the whole install. Only tried after the previous one failed.
PACKAGE_INDEXES = ('', 'https://pypi.tuna.tsinghua.edu.cn/simple',
                   'https://mirrors.aliyun.com/pypi/simple')
PROBE = """import bpy, os
_ext = bpy.utils.user_resource('EXTENSIONS')
print('BLMCP_INSTALLED=' + str(os.path.isdir(os.path.join(_ext, 'user_default', 'mcp'))))
print('BLMCP_ENABLED=' + str('bl_ext.user_default.mcp' in bpy.context.preferences.addons))
print('BLMCP_ONLINE=' + str(bpy.app.online_access))
"""


def run(*args):
    result = subprocess.run([str(arg) for arg in args], check=True,
                            text=True, stdout=subprocess.PIPE)
    return result.stdout


def install_packages(python, packages, runner):
    for index in PACKAGE_INDEXES:
        arguments = [python, '-m', 'pip', 'install', '--disable-pip-version-check',
                     '--timeout', '30']
        if index:
            print('pip install failed, retrying with', index)
            arguments += ['--index-url', index]
        try:
            runner(*arguments, *packages)
            return
        except subprocess.CalledProcessError:
            continue
    raise ValueError('pip install failed with PyPI and every mirror.')


def extract_source(archive, source):
    """Unpack the zip `git archive` wrote. It stores the commit id as the zip comment."""
    with zipfile.ZipFile(archive) as bundle:
        if bundle.comment.decode('ascii', 'replace') != REVISION:
            raise ValueError('Source archive is not the pinned upstream revision.')
        bundle.extractall(source)


def blender_executable(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError('Blender path must be absolute.')
    if path.suffix.lower() == '.app':
        path = path / 'Contents' / 'MacOS' / 'Blender'
    path = path.resolve(strict=True)
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError('Blender path must identify an executable file or Blender.app.')
    return path


def install(blender_path, install_directory, runner=run, source_archive=None):
    blender = blender_executable(blender_path)
    version = re.search(r'Blender (\d+)\.(\d+)', runner(blender, '--version'))
    if not version or tuple(map(int, version.groups())) < (5, 1):
        raise ValueError('The official Blender Lab add-on requires Blender 5.1 or newer.')
    root = Path(install_directory).expanduser()
    if not root.is_absolute():
        raise ValueError('Install directory must be absolute.')
    root = root.resolve()
    source = root / 'source'
    record = root / 'installed-revision.txt'
    environment = root / 'venv'
    python = environment / 'bin' / 'python'
    server = environment / 'bin' / 'blender-mcp'
    if root.exists():
        if not record.is_file() or record.read_text().strip() != REVISION:
            raise ValueError('Install directory is in use or incomplete. Choose a new directory; nothing was removed.')
        # A source unpacked from the shipped archive has no .git; the record is the proof
        if (source / '.git').exists() and \
                runner('git', '-C', source, 'rev-parse', 'HEAD').strip() != REVISION:
            raise ValueError('Installed source revision mismatch.')
        if not python.is_file() or not server.is_file():
            raise ValueError('Installed environment is incomplete. Choose a new directory.')
    else:
        # Claim a new directory, never erase or overwrite a partial installation.
        root.mkdir(parents=True)
        if source_archive:
            extract_source(source_archive, source)
        else:
            runner('git', 'init', '--quiet', source)
            runner('git', '-C', source, 'remote', 'add', 'origin', ORIGIN)
            runner('git', '-C', source, 'fetch', '--quiet', '--depth', '1', 'origin', REVISION)
            runner('git', '-C', source, 'checkout', '--quiet', '--detach', 'FETCH_HEAD')
            if runner('git', '-C', source, 'rev-parse', 'HEAD').strip() != REVISION:
                raise ValueError('Upstream revision mismatch.')
        runner(sys.executable, '-m', 'venv', environment)
        install_packages(python, [source / 'mcp', 'mcp[cli]>=1.2,<2'], runner)
        runner(server, '--help')
        record.write_text(REVISION + '\n', encoding='ascii')

    addon = root / 'blender-lab-mcp.zip'
    runner(blender, '--background', '--disable-autoexec', '--command', 'extension', 'build',
           '--source-dir', source / 'addon' / 'blender_mcp_addon', '--output-filepath', addon)
    runner(blender, '--background', '--disable-autoexec', '--command', 'extension',
           'install-file', '--repo', 'user_default', '--enable', addon)
    report = runner(blender, '--background', '--disable-autoexec', '--python-expr', PROBE)
    if 'BLMCP_INSTALLED=True' not in report.splitlines():
        raise ValueError('Official add-on is not installed. Retry setup to repair the add-on.')
    if 'BLMCP_ENABLED=True' not in report.splitlines():
        raise ValueError('Official add-on is not enabled. Enable it in Preferences > Extensions.')
    entry = {'mcpServers': {'blender': {
        'type': 'stdio', 'command': str(server), 'args': ['--transport', 'stdio'],
        'env': {'BLENDER_MCP_HOST': '127.0.0.1', 'BLENDER_MCP_PORT': '9876',
                'BLENDER_PATH': str(blender)}
    }}}
    destination = root / 'mcp-entry.json'
    temporary = root / 'mcp-entry.json.tmp'
    temporary.write_text(json.dumps(entry, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(destination)
    print('MCP config:', destination)
    print('Official add-on verified installed and enabled.')
    # Machine-readable, for a caller that reports this in its own words. Box parses
    # this line; matching the prose below would break the moment someone rewords it.
    online = 'BLMCP_ONLINE=True' in report.splitlines()
    print('BLMCP_ONLINE=' + str(online))
    if not online:
        print('Online access is OFF. Let Box launch Blender with --online-mode, or enable')
        print('Preferences > System > Network > Allow Online Access for manual launches.')
    print('Add the generated server entry in Box MCP settings and reconnect.')
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--blender-path', required=True, help='Absolute Blender.app or executable path')
    parser.add_argument('--install-directory', default=str(
        Path.home() / 'Library' / 'Application Support' / 'UnrealBox' / 'BlenderMcp' / REVISION[:8]))
    # Zip of the pinned revision that Box ships; without it the source comes from git
    parser.add_argument('--source-archive', help='git archive zip of the pinned revision')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This entry point is for macOS. Use setup_mcp.ps1 on Windows.')
    if sys.version_info < (3, 11):
        parser.error('Run this script with Python 3.11 or newer.')
    if os.geteuid() == 0:
        parser.error('Run as your normal user, without sudo.')
    try:
        install(args.blender_path, args.install_directory, source_archive=args.source_archive)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Setup failed: {error}\n')


if __name__ == '__main__':
    main()
