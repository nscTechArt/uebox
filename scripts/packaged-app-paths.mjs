import { join } from 'node:path'

/** Keep Windows layout unchanged; macOS binaries live inside the app bundle. */
export function packagedAppPaths(root, platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') {
    const folder = arch === 'x64' ? 'mac' : `mac-${arch}`
    const contents = join(root, 'dist', folder, '虚幻盒子.app', 'Contents')
    return {
      exe: join(contents, 'MacOS', '虚幻盒子'),
      asar: join(contents, 'Resources', 'app.asar')
    }
  }
  return {
    exe: join(root, 'dist', 'win-unpacked', 'unreal-agent.exe'),
    asar: join(root, 'dist', 'win-unpacked', 'resources', 'app.asar')
  }
}
