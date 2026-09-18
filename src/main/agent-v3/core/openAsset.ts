import { runEditorPython } from './editorPython'

/**
 * 在编辑器里打开一个资产，并在内容浏览器里选中它。
 *
 * ## 为什么这条能力值得存在
 *
 * 「本轮改动」列清了这一轮动过哪些资产之后，用户下一句一定是「那我看看」。
 * 而一行字 —— 哪怕写成「新建材质 M_GlowBreath · 10 个节点 · 9 处连线」——
 * 也说不清那个材质长什么样。**它答的是「agent 干了多少活」，不是「这东西现在
 * 是什么」**。让用户一键在编辑器里打开，眼见为实，比任何文字描述都短。
 *
 * ## 为什么不是在清单里显示缩略图
 *
 * 试过，走不通。`.uasset` 里的缩略图是**编辑器渲染过一遍之后**才写进包的，
 * 而 agent 的资产是用脚本建出来的，那一遍渲染从来没发生 —— 也就是说恰恰是
 * 这个面板要展示的那些资产（刚刚新建的那些），包里根本没有缩略图可读。
 * 仓库里现成的 `uasset-reader-new.js` 能解出缩略图，但对这里的资产会一律解出空。
 *
 * 补上它得在插件侧调 `ThumbnailTools::GenerateThumbnailForObjectToSaveToDisk`
 * （C++，Python 没有暴露），那是要改插件的另一件事，不在这条路上。
 *
 * ## 关卡不走这里
 *
 * 两个原因，都不是能绕过去的：`sync_browser_to_objects` 的文档明写对 level
 * 类型的资产无效；而 `open_editor_for_assets` 对关卡是**切换当前关卡**，
 * 用户只是想看一眼，不该被切走。界面据此不给关卡显示这个按钮。
 */

/**
 * 是不是引擎内的资产路径（`/Game/…`、`/Engine/…`、插件挂载点）。
 *
 * 「本轮改动」的 target 里混着三种东西：资产路径、Actor 名（`Cube`）、
 * 本地文件路径（`D:/proj/说明.html`）。只有第一种能在编辑器里打开。
 */
export function isContentPath(target: string): boolean {
  return /^\/[A-Za-z0-9_]+\/.+/.test(String(target ?? '').trim())
}

export interface OpenAssetResult {
  success: boolean
  /** 资产已经开着时引擎不会再开一个窗口，这里会是 false —— 不算失败 */
  opened?: boolean
  error?: string
}

export async function openAssetInEditor(contentPath: string): Promise<OpenAssetResult> {
  if (!isContentPath(contentPath)) {
    return { success: false, error: '不是引擎内的资产路径' }
  }

  const script = `
asset_path = ${JSON.stringify(contentPath)}
opened = False
missing = not unreal.EditorAssetLibrary.does_asset_exist(asset_path)

if not missing:
    asset = unreal.EditorAssetLibrary.load_asset(asset_path)
    if asset:
        subsystem = unreal.get_editor_subsystem(unreal.AssetEditorSubsystem)
        opened = bool(subsystem.open_editor_for_assets([asset]))
        # 打开的是一个独立的编辑器窗口，用户还得知道这东西放在哪，
        # 所以顺手在内容浏览器里也选中它。这一步是异步的（要几帧才落地），不等它
        unreal.EditorAssetLibrary.sync_browser_to_objects([asset_path])
    else:
        missing = True

output_data = {"opened": opened, "missing": missing}
`

  const result = await runEditorPython(script, `打开 ${contentPath}`)
  if (!result.success) return { success: false, error: result.error }

  const output = result.output || {}
  if (output.missing === true) {
    return { success: false, error: '资产不存在，可能已经被移动或删除了' }
  }

  // 已经开着的资产 `open_editor_for_assets` 回 false —— 那不是失败，
  // 用户要的窗口本来就在。判成失败会平白弹一个错误提示。
  return { success: true, opened: output.opened === true }
}
