/**
 * `uebox viewport screenshot` —— 把视口画面存成用户指定的那个 PNG 文件。
 *
 * ## 这条命令交付的是文件，不是「调用成功」
 *
 * 工具回 `saved: true` 只说明**插件那一步**写盘成功了。用户要的是
 * `--output` 那个路径上有一张能打开的图。中间隔着路径解析、磁盘空间、权限、
 * 覆盖策略。所以流程是：
 *
 *   1. 先判目标位置（已存在且没给 --overwrite 就直接停，别白跑一趟引擎）
 *   2. 请插件写到**目标目录里的一个唯一临时文件**
 *   3. 读回来核验：存在、非空、是 PNG、尺寸和引擎报的对得上
 *   4. 原子改名发布到目标文件
 *
 * 临时文件放在目标目录而不是系统临时目录，是为了第 4 步能是同卷改名 ——
 * 跨卷的话 rename 会退化成「复制 + 删除」，中途断电就在目标路径上留下半张图。
 *
 * ## 不用返回值里那张图
 *
 * 结果里的 base64 已经被 `compressForContext()` 缩到 768px 并重新编码。
 * 拿它交付等于给用户一张不是他要的图。原始像素只在插件写出的那个文件里，
 * 所以一律以 `path` 为准。
 *
 * ## 同机假设
 *
 * 插件在 UE 编辑器进程里写盘，CLI 在本机读盘 —— 这依赖盒子与编辑器在同一台
 * 机器上。当前架构（本机 WebSocket + 本机插件）成立。将来若拆开，这条命令
 * 要改成让插件把字节回传，而不是双方约定一个路径。
 */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'

import { success, type Artifact, type Envelope } from '../envelope.js'
import { UeboxError } from '../errors.js'
import { assertMatchesReported, PngError, readPngHeader } from '../png.js'
import * as runtime from '../runtime.js'

const TOOL = 'ue_screenshot'

export interface ScreenshotOptions {
  output: string
  configPath?: string
  timeoutSeconds?: number
  project?: string
  world?: 'auto' | 'editor'
  overwrite?: boolean
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export async function runViewportScreenshot(options: ScreenshotOptions): Promise<Envelope> {
  const target = await prepareTarget(options)

  const rt = await runtime.open({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.env ? { env: options.env } : {})
  })

  // 这次让插件写到哪儿。绝对路径 —— 插件对绝对路径是原样写入并自动建目录，
  // 相对路径则只取文件名塞进它自己的 Saved/Screenshots/UAL/
  const stagedPath = `${target}.${randomUUID()}.tmp.png`
  /** 插件确实写到了我们请求的那个路径（而不是它自己的 Saved/Screenshots/UAL/） */
  let staged = false

  try {
    const catalog = await runtime.catalog(rt)
    if (!catalog.some((item) => item.name === TOOL)) {
      throw new UeboxError(
        'TOOL_UNAVAILABLE',
        `虚幻盒子没有开放 ${TOOL}，无法截图。`,
        '在盒子的 MCP 设置里确认暴露范围没有被命名空间白名单收得太窄。'
      )
    }

    const project = await runtime.targetProject(rt, options.project)

    const result = await runtime.callTool(
      rt,
      TOOL,
      {
        filepath: stagedPath,
        // auto 是插件那边的默认行为，不用发；只有强制拍编辑器世界才说一声
        ...(options.world === 'editor' ? { world: 'editor' } : {})
      },
      project.path
    )

    const shot = result.structuredContent
    if (!shot) {
      throw new UeboxError(
        'INCOMPATIBLE_SERVER',
        '虚幻盒子没有返回结构化的截图结果。',
        '升级虚幻盒子 —— 拿不到文件路径就没法把图交付到 --output。'
      )
    }

    // 插件说没存下来就是没存下来。收到图片附件不是成功的依据。
    if (shot.saved === false) {
      throw new UeboxError(
        'OUTPUT_WRITE_FAILED',
        `引擎渲染出了画面但没能写盘：${str(shot.saveError) ?? '未提供原因'}`,
        '检查目标磁盘的剩余空间和写入权限。',
        'failed'
      )
    }

    const sourcePath = str(shot.path)
    if (!sourcePath) {
      throw new UeboxError(
        'OUTPUT_INVALID',
        '引擎没有报告截图文件的路径，无法交付到 --output。',
        undefined,
        'unknown'
      )
    }

    staged = normalize(sourcePath) === normalize(stagedPath)

    const info = await verify(sourcePath, shot)
    const bytes = await publish(sourcePath, target, staged)

    const artifact: Artifact = {
      path: target,
      mimeType: 'image/png',
      bytes,
      role: 'image'
    }

    return success({
      project: { name: project.name, path: project.path },
      data: {
        output: target,
        width: info.width,
        height: info.height,
        bytes,
        // 一张图的结论对不对，取决于它是从哪儿拍的 —— 这三个字段必须跟着走
        world: shot.world ?? null,
        view: shot.view ?? null,
        cameraSource: shot.cameraSource ?? null,
        cameraLocation: shot.cameraLocation ?? null,
        cameraRotation: shot.cameraRotation ?? null,
        units: { cameraLocation: 'cm', cameraRotation: 'deg' }
      },
      artifacts: [artifact],
      warnings: describeCaveats(shot)
    })
  } finally {
    // 无条件清理 `stagedPath`。
    //
    // 它是这一次现取的 UUID 路径，除了这次调用不可能有别的东西叫这个名字，
    // 所以删它不会误伤。而**只在成功路径上清理是不够的**：真机上验证超时行为时
    // 发现，`--timeout 2` 打断截图之后 `staged` 还是 false（它是在拿到结果之后
    // 才置位的），于是插件万一在我们放弃之后才写完，那个临时文件就永远留在
    // 用户的输出目录里了 —— 名字还是 `视口 截图.png.<uuid>.tmp.png` 这种。
    //
    // 残留窗口没法完全关掉：插件在我们清理**之后**才写完的话，谁也拦不住 ——
    // 那需要底层支持取消，而 V1 没有（§7）。这里做的是把能关的那部分关上。
    //
    // 插件写到它自己 Saved/Screenshots/UAL/ 的那份是它的产物，不归我们删。
    await fs.rm(stagedPath, { force: true }).catch(() => undefined)
    await rt.close()
  }
}

/**
 * 定下目标文件，并把该拦的先拦掉。
 *
 * 顺序有意为之：**在连接引擎之前**就判「已存在且不许覆盖」。反过来的话，
 * 用户要等完一整轮渲染，才被告知一个第一秒就能知道的错误。
 */
async function prepareTarget(options: ScreenshotOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd()
  const raw = options.output

  if (!/\.png$/i.test(raw)) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      `--output 这一版只接受 .png 文件，收到：${raw}`,
      '写成 .\\artifacts\\viewport.png 这样。'
    )
  }

  const target = (isAbsolute(raw) ? raw : resolve(cwd, raw)).replace(/\\/g, '/')

  const exists = await fs
    .stat(target)
    .then(() => true)
    .catch(() => false)

  if (exists && !options.overwrite) {
    throw new UeboxError(
      'OUTPUT_EXISTS',
      `目标文件已经存在：${target}`,
      '换一个 --output，或者显式加 --overwrite。默认不覆盖是为了不悄悄毁掉上一张。'
    )
  }

  try {
    await fs.mkdir(dirname(target), { recursive: true })
  } catch (error) {
    throw new UeboxError(
      'OUTPUT_WRITE_FAILED',
      `建不了输出目录 ${dirname(target)}：${(error as Error).message}`
    )
  }

  return target
}

/** 读文件并核验。核验不过一律非零退出，绝不因为「工具说成功了」就放行 */
async function verify(
  path: string,
  shot: Record<string, unknown>
): Promise<{ width: number; height: number }> {
  let buffer: Buffer
  try {
    buffer = await fs.readFile(path)
  } catch (error) {
    throw new UeboxError(
      'OUTPUT_INVALID',
      `引擎报告截图已保存到 ${path}，但这个文件读不到：${(error as Error).message}`,
      '确认虚幻盒子和虚幻编辑器跑在同一台机器上 —— 这条命令要从本地磁盘读回原图。',
      'failed'
    )
  }

  try {
    const info = readPngHeader(buffer)
    assertMatchesReported(info, {
      width: num(shot.width),
      height: num(shot.height)
    })
    return info
  } catch (error) {
    if (error instanceof PngError) {
      throw new UeboxError('OUTPUT_INVALID', `${path}：${error.message}`, undefined, 'failed')
    }
    throw error
  }
}

/**
 * 发布到目标文件。
 *
 * 同目录下的 rename 是原子的：要么用户拿到完整的新图，要么原来那张原封不动。
 * 失败时**保留原有文件** —— 覆盖失败还把旧的毁了是最坏的结果。
 */
async function publish(sourcePath: string, target: string, staged: boolean): Promise<number> {
  try {
    if (staged) {
      await fs.rename(sourcePath, target)
    } else {
      // 插件把图写到了别处（老插件不认绝对路径，只取文件名）。
      // 先复制到目标目录的临时文件，再改名 —— 直接往目标路径写的话，
      // 写到一半失败就在那儿留下半张图。
      const relay = `${target}.${randomUUID()}.tmp.png`
      try {
        await fs.copyFile(sourcePath, relay)
        await fs.rename(relay, target)
      } catch (error) {
        await fs.rm(relay, { force: true }).catch(() => undefined)
        throw error
      }
    }

    const stats = await fs.stat(target)
    if (stats.size === 0) {
      throw new Error('发布之后目标文件是 0 字节')
    }
    return stats.size
  } catch (error) {
    throw new UeboxError(
      'OUTPUT_WRITE_FAILED',
      `图片没能交付到 ${target}：${(error as Error).message}`,
      '检查目标路径的写入权限和磁盘空间。原有文件（如果有）没有被改动。',
      'failed'
    )
  }
}

/**
 * 这张图能不能拿来下结论。
 *
 * 三条已知限制都要说出来，不能咽掉 —— 它们决定的是「看到的东西算不算数」。
 */
function describeCaveats(shot: Record<string, unknown>): string[] {
  const warnings: string[] = []

  if (shot.cameraSource === 'fallback') {
    warnings.push(
      '没找到编辑器的透视视口，这一帧是从兜底机位拍的，不是用户屏幕上看到的画面。' +
        '构图是随机的：画面里没有某个东西，不代表它不在场景里。'
    )
  }

  const pending: string[] = []
  if (numOr0(shot.pendingShaders) > 0) pending.push(`${shot.pendingShaders} 个着色器还在编译`)
  if (numOr0(shot.pendingAssets) > 0) pending.push(`${shot.pendingAssets} 个资产还在编译`)
  if (numOr0(shot.streamingInFlight) > 0) pending.push(`${shot.streamingInFlight} 个贴图还没流送完`)
  if (pending.length > 0) {
    warnings.push(
      `这一帧不是最终画面：${pending.join('；')}。不要据此判断材质或贴图有问题，等一会儿再截一张。`
    )
  }

  // 这条限制与现场状态无关，永远成立，所以永远要说
  warnings.push(
    '这条路自己渲一帧，自动曝光的收敛状态和编辑器视口不同，实测整体偏暗一档。' +
      '可以判断物体在不在、位置、材质颜色、灯亮没亮；不要据此判断整体过曝/欠曝或要不要调曝光。'
  )

  return warnings
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numOr0(value: unknown): number {
  return num(value) ?? 0
}

function normalize(path: string): string {
  const unified = path.replace(/\\/g, '/')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}
