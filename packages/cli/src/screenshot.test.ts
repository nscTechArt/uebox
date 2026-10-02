/** @vitest-environment node */
// 假盒子的 handle 是同步的，写盘也得同步 —— 所以除了 promises 还要一个 writeFileSync
import { promises as fs, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { run } from './cli.js'
import { fakePng, startFakeBox, type FakeBox, type FakeTool } from './testServer.js'

const boxes: FakeBox[] = []
const dirs: string[] = []

/**
 * 每条用例一个**真实存在**的工程目录。
 *
 * 不能拿 `D:/Games/Demo` 这种编出来的路径：`--project` 会先 `stat` 它，
 * 不存在就报 INVALID_ARGUMENT 直接退出 —— 这是设计要的行为（§5：显式路径
 * 不是有效工程目录时不能进入回退），所以测试也得给真路径。
 */
let PROJECT = { id: 'c1', name: 'Demo', path: '' }

beforeEach(async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'uebox 工程-'))
  dirs.push(root)
  const dir = join(root, 'Demo')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'Demo.uproject'), '{}')
  PROJECT = { id: 'c1', name: 'Demo', path: dir.replace(/\\/g, '/') }
})

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((box) => box.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const TOKEN = 'test-token-0123456789'

async function tempDir(prefix = 'uebox 截图-'): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function healthTool(): FakeTool {
  return {
    name: 'ue_session_health',
    meta: { namespace: 'ue.system', risk: 'safe', projectScoped: false },
    handle: () => ({
      content: [{ type: 'text', text: '1 个连接' }],
      structuredContent: {
        state: 'connected',
        connections: [
          {
            connectionId: PROJECT.id,
            projectName: PROJECT.name,
            projectPath: PROJECT.path,
            engineVersion: '5.5',
            isCurrentTarget: true
          }
        ]
      }
    })
  }
}

async function startBox(tools: FakeTool[]): Promise<FakeBox> {
  const box = await startFakeBox({ token: TOKEN, tools: [healthTool(), ...tools] })
  boxes.push(box)
  return box
}

function envFor(box: FakeBox): NodeJS.ProcessEnv {
  return { UEBOX_URL: box.url, UEBOX_TOKEN: TOKEN }
}

// ── viewport screenshot ─────────────────────────────────────────────────────

describe('viewport screenshot', () => {
  /**
   * 假插件：把图写到 CLI 指定的 filepath（真插件对绝对路径就是这么做的，
   * 见 UAL_EditorCommands.cpp）。`override` 用来模拟各种坏情况。
   */
  function screenshotTool(
    override: {
      width?: number
      height?: number
      writeTo?: 'requested' | 'elsewhere' | 'nothing'
      elsewhereDir?: string
      bodyWidth?: number
      bodyHeight?: number
      saved?: boolean
      saveError?: string
      cameraSource?: string
      pendingShaders?: number
      exposure?: string | null
      exposureSource?: string
    } = {}
  ): FakeTool {
    const width = override.width ?? 1920
    const height = override.height ?? 1080

    return {
      name: 'ue_screenshot',
      meta: { namespace: 'ue.editor', risk: 'safe', projectScoped: true },
      handle: (args) => {
        const requested = String(args.filepath ?? '')
        let written = requested

        if (override.writeTo === 'elsewhere') {
          written = join(override.elsewhereDir ?? tmpdir(), `ual-${Date.now()}.png`)
        }

        if (override.writeTo !== 'nothing' && override.saved !== false) {
          writeFileSync(
            written,
            fakePng(override.bodyWidth ?? width, override.bodyHeight ?? height)
          )
        }

        return {
          content: [
            { type: 'text', text: '截图已成功获取' },
            // 结果里的图是压缩预览，CLI 绝不能拿它交付
            { type: 'image', data: 'AAAA', mimeType: 'image/png' }
          ],
          structuredContent: {
            path: override.writeTo === 'nothing' ? written : written,
            width,
            height,
            saved: override.saved ?? true,
            saveError: override.saveError ?? null,
            world: 'editor',
            view: 'viewport',
            cameraSource: override.cameraSource ?? 'viewport',
            pendingShaders: override.pendingShaders ?? 0,
            exposure: override.exposure === undefined ? 'auto' : override.exposure,
            exposureSource: override.exposureSource ?? null,
            pendingAssets: 0,
            streamingInFlight: 0
          }
        }
      }
    }
  }

  it('把图交付到 --output，并核验尺寸', async () => {
    const dir = await tempDir()
    const output = join(dir, '视口 截图.png')
    const box = await startBox([screenshotTool()])

    const result = await run(
      ['viewport', 'screenshot', '--output', output, '--project', PROJECT.path, '--json'],
      envFor(box)
    )

    expect(result.exitCode).toBe(0)
    const envelope = JSON.parse(result.stdout)
    expect(envelope.data).toMatchObject({ width: 1920, height: 1080, cameraSource: 'viewport' })
    expect(envelope.artifacts).toHaveLength(1)
    expect(envelope.artifacts[0]).toMatchObject({ mimeType: 'image/png', role: 'image' })

    // 真的落地了，而且是张 PNG
    const bytes = await fs.readFile(output)
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(bytes.byteLength).toBeGreaterThan(0)
  })

  /** 终端里刷出二十万个字符的 base64 之后，用户什么都看不到了 */
  it('不把返回值里的 base64 图片打到输出里', async () => {
    const dir = await tempDir()
    const box = await startBox([screenshotTool()])

    const result = await run(
      [
        'viewport',
        'screenshot',
        '--output',
        join(dir, 'a.png'),
        '--project',
        PROJECT.path,
        '--json'
      ],
      envFor(box)
    )

    expect(result.stdout).not.toContain('AAAA')
  })

  it('临时文件不留在目标目录里', async () => {
    const dir = await tempDir()
    const box = await startBox([screenshotTool()])

    await run(
      [
        'viewport',
        'screenshot',
        '--output',
        join(dir, 'a.png'),
        '--project',
        PROJECT.path,
        '--json'
      ],
      envFor(box)
    )

    expect(await fs.readdir(dir)).toEqual(['a.png'])
  })

  it('目标已存在时默认不覆盖，退出码 2，原文件一个字节不动', async () => {
    const dir = await tempDir()
    const output = join(dir, 'a.png')
    await fs.writeFile(output, 'ORIGINAL')
    const box = await startBox([screenshotTool()])

    const result = await run(
      ['viewport', 'screenshot', '--output', output, '--project', PROJECT.path, '--json'],
      envFor(box)
    )

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout).error.code).toBe('OUTPUT_EXISTS')
    expect(await fs.readFile(output, 'utf8')).toBe('ORIGINAL')
  })

  it('--overwrite 才覆盖', async () => {
    const dir = await tempDir()
    const output = join(dir, 'a.png')
    await fs.writeFile(output, 'ORIGINAL')
    const box = await startBox([screenshotTool()])

    const result = await run(
      [
        'viewport',
        'screenshot',
        '--output',
        output,
        '--overwrite',
        '--project',
        PROJECT.path,
        '--json'
      ],
      envFor(box)
    )

    expect(result.exitCode).toBe(0)
    expect((await fs.readFile(output)).subarray(1, 4).toString('ascii')).toBe('PNG')
  })

  it('缺少的父目录会自动建出来', async () => {
    const dir = await tempDir()
    const output = join(dir, '新建', '子目录', 'a.png')
    const box = await startBox([screenshotTool()])

    const result = await run(
      ['viewport', 'screenshot', '--output', output, '--project', PROJECT.path, '--json'],
      envFor(box)
    )

    expect(result.exitCode).toBe(0)
    expect(await fs.stat(output)).toBeTruthy()
  })

  it('只接受 .png', async () => {
    const dir = await tempDir()
    const result = await run(['viewport', 'screenshot', '--output', join(dir, 'a.jpg'), '--json'], {
      UEBOX_URL: 'http://127.0.0.1:1/',
      UEBOX_TOKEN: 'x'
    })

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout).error.message).toContain('.png')
  })

  it('不给 --output 时报用法错误', async () => {
    const result = await run(['viewport', 'screenshot', '--json'], {})

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout).error.hint).toContain('--output')
  })

  /**
   * 这四条是这条命令的核心：**收到结果不等于文件交付了**。
   */
  it('插件说没存下来时报失败，不因为收到附件就成功', async () => {
    const dir = await tempDir()
    const box = await startBox([screenshotTool({ saved: false, saveError: '磁盘已满' })])

    const result = await run(
      [
        'viewport',
        'screenshot',
        '--output',
        join(dir, 'a.png'),
        '--project',
        PROJECT.path,
        '--json'
      ],
      envFor(box)
    )

    expect(result.exitCode).toBe(8)
    const envelope = JSON.parse(result.stdout)
    expect(envelope.error.code).toBe('OUTPUT_WRITE_FAILED')
    expect(envelope.error.message).toContain('磁盘已满')
    expect(await fs.readdir(dir)).toEqual([])
  })

  /**
   * 真机上发现的：`--timeout 2` 打断截图之后，`staged` 还没来得及置位
   * （它是拿到结果之后才置的），于是清理被跳过。插件万一在我们放弃之后
   * 才写完，那个临时文件就永远留在用户的输出目录里。
   *
   * 这条用「文件写出来了、但这次调用失败」来覆盖那条路径。
   */
  it('调用失败时也不留临时文件在输出目录里', async () => {
    const dir = await tempDir()
    const box = await startBox([
      {
        name: 'ue_screenshot',
        meta: { namespace: 'ue.editor', risk: 'safe', projectScoped: true },
        handle: (args) => {
          // 先照要求把文件写出来，再报失败 —— 顺序正是真机上那一幕
          writeFileSync(String(args.filepath), fakePng(64, 64))
          return {
            content: [{ type: 'text', text: '写完了但随后失败' }],
            structuredContent: {
              path: String(args.filepath),
              width: 64,
              height: 64,
              saved: false,
              saveError: '写完之后出错了'
            }
          }
        }
      }
    ])

    const result = await run(
      [
        'viewport',
        'screenshot',
        '--output',
        join(dir, 'a.png'),
        '--project',
        PROJECT.path,
        '--json'
      ],
      envFor(box)
    )

    expect(result.exitCode).toBe(8)
    // 目录必须是干净的：既没有目标文件，也没有 .tmp.png 残留
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('引擎报了路径但文件不在时报 OUTPUT_INVALID', async () => {
    const dir = await tempDir()
    const box = await startBox([screenshotTool({ writeTo: 'nothing' })])

    const result = await run(
      [
        'viewport',
        'screenshot',
        '--output',
        join(dir, 'a.png'),
        '--project',
        PROJECT.path,
        '--json'
      ],
      envFor(box)
    )

    expect(result.exitCode).toBe(8)
    expect(JSON.parse(result.stdout).error.code).toBe('OUTPUT_INVALID')
    expect(await fs.readdir(dir)).toEqual([])
  })

  /** 尺寸对不上多半是读到了上一次遗留的文件 —— 那张图会被拿去判断刚改的东西 */
  it('文件尺寸和引擎报的对不上时拒绝交付', async () => {
    const dir = await tempDir()
    const box = await startBox([
      screenshotTool({ width: 1920, height: 1080, bodyWidth: 640, bodyHeight: 480 })
    ])

    const result = await run(
      [
        'viewport',
        'screenshot',
        '--output',
        join(dir, 'a.png'),
        '--project',
        PROJECT.path,
        '--json'
      ],
      envFor(box)
    )

    expect(result.exitCode).toBe(8)
    expect(JSON.parse(result.stdout).error.message).toContain('对不上')
    expect(await fs.readdir(dir)).toEqual([])
  })

  /** 老插件不认绝对路径，只取文件名写进自己的 Saved/Screenshots/UAL/ */
  it('插件把图写到别处时也能交付', async () => {
    const dir = await tempDir()
    const elsewhere = await tempDir('uebox-saved-')
    const box = await startBox([screenshotTool({ writeTo: 'elsewhere', elsewhereDir: elsewhere })])

    const result = await run(
      [
        'viewport',
        'screenshot',
        '--output',
        join(dir, 'a.png'),
        '--project',
        PROJECT.path,
        '--json'
      ],
      envFor(box)
    )

    expect(result.exitCode).toBe(0)
    expect((await fs.readFile(join(dir, 'a.png'))).subarray(1, 4).toString('ascii')).toBe('PNG')
    // 插件自己那份产物不归我们删
    expect((await fs.readdir(elsewhere)).length).toBe(1)
  })

  it('--world editor 会发到服务端', async () => {
    const dir = await tempDir()
    let seen: Record<string, unknown> = {}
    const box = await startBox([
      {
        name: 'ue_screenshot',
        meta: { namespace: 'ue.editor', risk: 'safe', projectScoped: true },
        handle: (args) => {
          seen = args
          return {
            content: [{ type: 'text', text: 'x' }],
            structuredContent: {
              path: String(args.filepath),
              width: 8,
              height: 8,
              saved: false,
              saveError: 'stop'
            }
          }
        }
      }
    ])

    await run(
      [
        'viewport',
        'screenshot',
        '--output',
        join(dir, 'a.png'),
        '--world',
        'editor',
        '--project',
        PROJECT.path,
        '--json'
      ],
      envFor(box)
    )

    expect(seen.world).toBe('editor')
  })

  describe('已知限制要说出来', () => {
    type Shot = { data: Record<string, unknown>; warnings: string[] }
    const shoot = async (tool: FakeTool): Promise<Shot> => {
      const dir = await tempDir()
      const box = await startBox([tool])
      const result = await run(
        [
          'viewport',
          'screenshot',
          '--output',
          join(dir, 'a.png'),
          '--project',
          PROJECT.path,
          '--json'
        ],
        envFor(box)
      )
      return JSON.parse(result.stdout) as Shot
    }

    it('自动曝光时说明亮度没有基准，叫它先锁', async () => {
      const out = await shoot(screenshotTool({ exposure: 'auto' }))

      expect(out.data.exposure).toBe('auto')
      expect(out.warnings.join()).toContain('自动曝光')
      expect(out.warnings.join()).toContain('Metering Mode = Manual')
    })

    /**
     * 原来这里永远说「偏暗一档，别拿它判断曝光」，结果成了把发白归给截图偏差的借口。
     * 锁了手动曝光，截图的明暗就是玩家看到的，不能再叫调用方别信。
     */
    it('锁了手动曝光就不再说别信亮度', async () => {
      const out = await shoot(
        screenshotTool({ exposure: 'manual', exposureSource: 'post_process_volume' })
      )

      expect(out.data.exposure).toBe('manual')
      expect(out.warnings.join()).not.toContain('曝光')
      expect(out.warnings.join()).not.toContain('偏暗')
    })

    it('只锁了编辑器视口时提醒 PIE 和打包版不认它', async () => {
      const out = await shoot(screenshotTool({ exposure: 'manual', exposureSource: 'viewport' }))

      expect(out.warnings.join()).toContain('编辑器视口自己锁的')
    })

    it('老版本没报曝光时按自动曝光对待，不替它说锁了', async () => {
      const out = await shoot(screenshotTool({ exposure: null }))

      expect(out.data.exposure).toBeNull()
      expect(out.warnings.join()).toContain('按自动曝光对待')
    })

    it('兜底机位时警告构图不可信', async () => {
      const dir = await tempDir()
      const box = await startBox([screenshotTool({ cameraSource: 'fallback' })])

      const result = await run(
        [
          'viewport',
          'screenshot',
          '--output',
          join(dir, 'a.png'),
          '--project',
          PROJECT.path,
          '--json'
        ],
        envFor(box)
      )

      expect(JSON.parse(result.stdout).warnings.join()).toContain('不是用户屏幕上看到的画面')
    })

    it('还有着色器在编译时警告画面没到位', async () => {
      const dir = await tempDir()
      const box = await startBox([screenshotTool({ pendingShaders: 3 })])

      const result = await run(
        [
          'viewport',
          'screenshot',
          '--output',
          join(dir, 'a.png'),
          '--project',
          PROJECT.path,
          '--json'
        ],
        envFor(box)
      )

      expect(JSON.parse(result.stdout).warnings.join()).toContain('不是最终画面')
    })
  })
})
