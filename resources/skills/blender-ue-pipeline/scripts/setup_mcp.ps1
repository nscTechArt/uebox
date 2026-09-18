param(
  [Parameter(Mandatory = $true)][string]$BlenderPath,
  [Parameter(Mandatory = $true)][string]$PythonPath,
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'UnrealBox\BlenderMcp\4309a396'),
  # Installing the add-on used to be opt-in and was therefore skipped: server,
  # source and venv all present, only `install-file` never run. That failure
  # looks exactly like "the bridge is down", and it hides inside Blender's
  # extensions directory. It is now the default and is verified below.
  [switch]$SkipAddonInstall
)

$ErrorActionPreference = 'Stop'
$revision = '4309a39646e644261624bfcd2bca669b343b7621'
function Invoke-Checked([string]$Executable, [string[]]$CommandArguments) {
  & $Executable @CommandArguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Executable" }
}

$blenderExe = (Resolve-Path -LiteralPath $BlenderPath).ProviderPath
$pythonExe = (Resolve-Path -LiteralPath $PythonPath).ProviderPath
$blenderVersion = (& $blenderExe --version | Select-Object -First 1)
if ($blenderVersion -notmatch 'Blender (\d+)\.(\d+)' -or
    [version]"$($Matches[1]).$($Matches[2])" -lt [version]'5.1') {
  throw 'The official Blender Lab add-on requires Blender 5.1 or newer.'
}
Invoke-Checked $pythonExe @('-c', 'import sys; assert sys.version_info >= (3, 11), "Python 3.11 or newer is required"')
if (-not [IO.Path]::IsPathRooted($InstallDirectory)) { throw 'InstallDirectory must be absolute.' }
$installRoot = [IO.Path]::GetFullPath($InstallDirectory)
$sourceRoot = Join-Path $installRoot 'source'
$record = Join-Path $installRoot 'installed-revision.txt'
if (Test-Path -LiteralPath $installRoot) {
  if (-not (Test-Path -LiteralPath $record) -or (Get-Content -LiteralPath $record -Raw).Trim() -ne $revision) {
    throw 'InstallDirectory is already in use or contains an incomplete install. Choose a new directory; nothing was removed.'
  }
} else {
  New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
  Invoke-Checked 'git' @('init', '--quiet', $sourceRoot)
  Invoke-Checked 'git' @('-C', $sourceRoot, 'remote', 'add', 'origin', 'https://projects.blender.org/lab/blender_mcp.git')
  Invoke-Checked 'git' @('-C', $sourceRoot, 'fetch', '--quiet', '--depth', '1', 'origin', $revision)
  Invoke-Checked 'git' @('-C', $sourceRoot, 'checkout', '--quiet', '--detach', 'FETCH_HEAD')
  if ((& git -C $sourceRoot rev-parse HEAD).Trim() -ne $revision) { throw 'Upstream revision mismatch.' }
  Invoke-Checked $pythonExe @('-m', 'venv', (Join-Path $installRoot 'venv'))
  $environmentPython = Join-Path $installRoot 'venv\Scripts\python.exe'
  Invoke-Checked $environmentPython @('-m', 'pip', 'install', '--disable-pip-version-check', (Join-Path $sourceRoot 'mcp'), 'mcp[cli]>=1.2,<2')
  Invoke-Checked (Join-Path $installRoot 'venv\Scripts\blender-mcp.exe') @('--help')
  $revision | Set-Content -LiteralPath $record -Encoding ascii
}

$addonZip = Join-Path $installRoot 'blender-lab-mcp.zip'
Invoke-Checked $blenderExe @('--background', '--disable-autoexec', '--command', 'extension', 'build', '--source-dir', (Join-Path $sourceRoot 'addon\blender_mcp_addon'), '--output-filepath', $addonZip)
if (-not $SkipAddonInstall) {
  Invoke-Checked $blenderExe @('--background', '--disable-autoexec', '--command', 'extension', 'install-file', '--repo', 'user_default', '--enable', $addonZip)
}

# Ask Blender itself whether the add-on is installed, enabled, and whether online
# access is on. Without this read-back, any of the three failing only surfaces at
# the first tool call, as one line of "Cannot connect to Blender" that points here
# in no way at all.
#
# Joined array rather than a here-string: this file uses LF endings and Windows
# PowerShell 5.1 wants CRLF around @" "@, which fails to parse. Keep this file
# ASCII too — without a BOM (the skill standard forbids one) 5.1 decodes it as the
# system code page and non-ASCII comments break the parser.
$probe = @(
  "import bpy, os",
  "_ext = bpy.utils.user_resource('EXTENSIONS')",
  "print('BLMCP_INSTALLED=' + str(os.path.isdir(os.path.join(_ext, 'user_default', 'mcp'))))",
  "print('BLMCP_ENABLED=' + str('bl_ext.user_default.mcp' in bpy.context.preferences.addons))",
  "print('BLMCP_ONLINE=' + str(bpy.app.online_access))"
) -join "`n"
$report = (& $blenderExe --background --disable-autoexec --python-expr $probe) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Could not read the add-on state back from Blender.' }
if ($report -notmatch 'BLMCP_INSTALLED=True') {
  throw 'The official add-on is not in Blender''s extensions directory. Re-run without -SkipAddonInstall.'
}
if ($report -notmatch 'BLMCP_ENABLED=True') {
  throw 'The official add-on is installed but not enabled. Enable it in Preferences > Extensions.'
}
$onlineAccess = $report -match 'BLMCP_ONLINE=True'

$entry = @{mcpServers = @{blender = @{
  type = 'stdio'
  command = (Join-Path $installRoot 'venv\Scripts\blender-mcp.exe')
  args = @('--transport', 'stdio')
  env = @{BLENDER_MCP_HOST = '127.0.0.1'; BLENDER_MCP_PORT = '9876'; BLENDER_PATH = $blenderExe}
}}}
[IO.File]::WriteAllText((Join-Path $installRoot 'mcp-entry.json'), ($entry | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Output "MCP config: $(Join-Path $installRoot 'mcp-entry.json')"
Write-Output "Official add-on: $addonZip"
Write-Output 'Add-on verified installed and enabled in Blender.'
if ($onlineAccess) {
  Write-Output 'Online access is enabled, so a manually opened Blender starts the bridge too.'
} else {
  # Off by default, and the add-on treats opening the bridge as going online, so it
  # refuses to listen. Box passes --online-mode when it launches Blender, so this
  # setting can stay off; a Blender the user opened by hand will simply never have a
  # bridge, which reads as a broken install unless it is spelled out.
  Write-Output 'Online access is OFF in Blender. The add-on refuses to open the port without it.'
  Write-Output '  Box launches Blender with --online-mode, so leave the launching to Box,'
  Write-Output '  or enable Preferences > System > Network > Allow Online Access once.'
}
Write-Output 'Then add the server to Box MCP settings and reconnect.'
