/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from './cli.js'
import {
  fakeLevel,
  fakeUndoStack,
  startFakeBox,
  type FakeBox,
  type FakeTool
} from './testServer.js'
import { ADMITTED_WRITE_TOOLS, admittedWrite, type ActorReadback } from './write.js'

const boxes: FakeBox[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((box) => box.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const TOKEN = 'test-token-0123456789'

function healthTool(path: string): FakeTool {
  return {
    name: 'ue_session_health',
    meta: { namespace: 'ue.system', risk: 'safe', projectScoped: false },
    handle: () => ({
      content: [{ type: 'text', text: '1 个连接' }],
      structuredContent: {
        state: 'connected',
        connections: [
          {
            connectionId: 'c1',
            projectName: 'Demo',
            projectPath: path,
            engineVersion: '5.5',
            isCurrentTarget: true
          }
        ]
      }
    })
  }
}

async function projectDir(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'uebox-write-'))
  dirs.push(root)
  const dir = join(root, 'Demo')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'Demo.uproject'), '{}')
  return dir.replace(/\\/g, '/')
}

/** 起一个带关卡的假盒子，返回跑命令要的东西 */
async function scene(
  options: Parameters<typeof fakeLevel>[0] = {}
): Promise<{ env: NodeJS.ProcessEnv; project: string; level: ReturnType<typeof fakeLevel> }> {
  const project = await projectDir()
  const level = fakeLevel(options)
  const box = await startFakeBox({ token: TOKEN, tools: [healthTool(project), ...level.tools] })
  boxes.push(box)
  return { env: { UEBOX_URL: box.url, UEBOX_TOKEN: TOKEN }, project, level }
}

/**
 * 信封是三四层的动态 JSON，断言要一路点下去（`data.verified.done`）。
 *
 * 用一个递归的宽松类型而不是 `any`：点错字段名照样会红，而逐层建接口
 * 只会多出一份得跟着实现改的重复定义。
 */
interface Json {
  [key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

function payload(stdout: string): Json {
  return JSON.parse(stdout) as Json
}

// ── 准入表本身 ──────────────────────────────────────────────────────────────

describe('写操作加强档', () => {
  /*
   * 这一组断言的意思变了，连着这段读：
   *
   * 它们说的是「这些工具没有**加强档**」，不是「调不了」。§12.10 把准入表拆了，
   * 加上 `--allow-write`，这些工具从 `tools call` 都调得到 —— 盒子自己的 agent
   * 能用的，CLI 不该更窄。这里钉的是 `write.ts` 那张表**没有悄悄变长**：
   * 往里加条目等于声称「CLI 能替它核实」，而下面两类核实不了。
   */
  it('加强档只有三条关卡内对象操作', () => {
    expect(ADMITTED_WRITE_TOOLS.sort()).toEqual([
      'ue_destroy_actor',
      'ue_set_transform',
      'ue_spawn_actor'
    ])
  })

  /** §12.2：资产操作没有事务，唯一的回退（assetSnapshot）至今没有调用方 */
  it.each([
    'ue_content_import',
    'ue_content_move',
    'ue_content_delete',
    'ue_content_migrate',
    'ue_save'
  ])('资产类写操作 %s 没有加强档', (tool) => {
    expect(admittedWrite(tool)).toBeUndefined()
  })

  /** §12.2：既查不到也撤不回，永远写不出外部判据 */
  it.each(['ue_run_python_script', 'ue_run_console_command'])('%s 永远不会有加强档', (tool) => {
    expect(admittedWrite(tool)).toBeUndefined()
  })

  /** 只有生成是重发有代价的，这条差别决定了超时提示怎么写 */
  it('只有生成不幂等', () => {
    expect(admittedWrite('ue_spawn_actor')!.idempotent).toBe(false)
    expect(admittedWrite('ue_set_transform')!.idempotent).toBe(true)
    expect(admittedWrite('ue_destroy_actor')!.idempotent).toBe(true)
  })

  /** 删除那条的读法和另外两条是反的，讲反了会让人重发一条已经生效的删除 */
  it('三条的回读读法各说各的', () => {
    expect(admittedWrite('ue_destroy_actor')!.readbackMeaning).toContain('查不到 = 已经删掉')
    expect(admittedWrite('ue_spawn_actor')!.readbackMeaning).toContain('不要重发')
  })
})

describe('参数收窄', () => {
  const constrain = (tool: string, args: Record<string, unknown>): void => {
    admittedWrite(tool)!.constrain(args)
  }

  /**
   * 增量变换不幂等 —— 一次超时之后无法判断该不该重发，重发就是移动两倍。
   * 这条是准入条件本身，不是「参数校验」。
   */
  it.each(['add', 'multiply'])('ue_set_transform 拒绝 %s（不幂等）', (key) => {
    expect(() =>
      constrain('ue_set_transform', {
        targets: { names: ['Cube'] },
        operation: { [key]: { location: { z: 100 } } }
      })
    ).toThrow(/不幂等|不支持/)
  })

  /** 幂等，但说不出期望值：地板在哪个 Z 只有引擎知道，回读无从比对 */
  it('ue_set_transform 拒绝 snap_to_floor（回读说不出期望值）', () => {
    expect(() =>
      constrain('ue_set_transform', {
        targets: { names: ['Cube'] },
        operation: { snap_to_floor: true, set: { location: { x: 0 } } }
      })
    ).toThrow(/snap_to_floor/)
  })

  /** 指向哪些对象要到引擎那边才知道，失败之后无法核实改了哪些 */
  it.each(['filter', 'selection', 'paths'])('拒绝 targets.%s', (key) => {
    expect(() =>
      constrain('ue_set_transform', {
        targets: { [key]: key === 'selection' ? true : {} },
        operation: { set: { location: { z: 1 } } }
      })
    ).toThrow(/不支持/)
  })

  /** §12.3 第三条：部分成功会留下一个枚举不出来的状态 */
  it('一次只能点名一个 Actor', () => {
    expect(() =>
      constrain('ue_set_transform', {
        targets: { names: ['A', 'B'] },
        operation: { set: { location: { z: 1 } } }
      })
    ).toThrow(/一次只能点名一个/)
  })

  it.each(['instances', 'batch'])('ue_spawn_actor 拒绝 %s（批量）', (key) => {
    expect(() => constrain('ue_spawn_actor', { [key]: [{ class: 'X', name: 'Y' }] })).toThrow(
      /不支持/
    )
  })

  /** 不给名字的话引擎自己分配，超时之后就没有回读判据了（§12.3 第一条） */
  it('ue_spawn_actor 必须给 name', () => {
    expect(() => constrain('ue_spawn_actor', { asset_id: 'StaticMeshActor' })).toThrow(
      /必须给 name/
    )
  })

  it('ue_destroy_actor 拒绝 batch', () => {
    expect(() => constrain('ue_destroy_actor', { batch: [{ name: 'A' }] })).toThrow(/不支持 batch/)
  })

  it('合法的绝对设置放行', () => {
    expect(() =>
      constrain('ue_set_transform', {
        targets: { names: ['Cube'] },
        operation: { set: { location: { z: 200 } } }
      })
    ).not.toThrow()
  })
})

describe('回读判定', () => {
  const verify = admittedWrite('ue_set_transform')!.verify
  const args = (set: Record<string, unknown>): Record<string, unknown> => ({
    targets: { names: ['Cube'] },
    operation: { set }
  })
  const actor = (transform: ActorReadback['transform']): ActorReadback => ({
    name: 'Cube',
    path: null,
    class: null,
    transform
  })

  /** 引擎存 float，200 回读可能是 199.99998。逐位相等会把成功判成失败 */
  it('容忍浮点误差', () => {
    const verdict = verify(
      args({ location: { z: 200 } }),
      actor({ location: { x: 0, y: 0, z: 199.99998 }, rotation: null, scale: null })
    )
    expect(verdict.done).toBe(true)
  })

  /** 只设 z 的时候 x/y 保持原值，拿它们去比会把一次正确的写操作判成失败 */
  it('只比请求里写了的分量', () => {
    const verdict = verify(
      args({ location: { z: 200 } }),
      actor({ location: { x: 999, y: -50, z: 200 }, rotation: null, scale: null })
    )
    expect(verdict.done).toBe(true)
  })

  /** yaw 370 回读是 10，-180 和 180 是同一个朝向 */
  it.each([
    [370, 10],
    [-180, 180],
    [0, 360]
  ])('角度按绕圈算：要求 %s 回读 %s 算一致', (wanted, got) => {
    const verdict = verify(
      args({ rotation: { yaw: wanted } }),
      actor({ location: null, rotation: { pitch: 0, yaw: got, roll: 0 }, scale: null })
    )
    expect(verdict.done).toBe(true)
  })

  it('真对不上就是没生效', () => {
    const verdict = verify(
      args({ location: { z: 200 } }),
      actor({ location: { x: 0, y: 0, z: 0 }, rotation: null, scale: null })
    )
    expect(verdict.done).toBe(false)
    expect(verdict.detail).toContain('要求 200')
  })

  it('Actor 不见了也是没生效', () => {
    expect(verify(args({ location: { z: 1 } }), null).done).toBe(false)
  })
})

// ── 端到端 ──────────────────────────────────────────────────────────────────

describe('写操作要显式开', () => {
  /**
   * 盒子里开了写工具还不够。CLI 这头一个审批弹窗都没有，`--allow-write`
   * 就是顶替那一下的东西。
   */
  it('不给 --allow-write 时 actors move 被挡下，退出码 6', async () => {
    const { env, project, level } = await scene({ actors: [{ name: 'Cube' }] })

    const result = await run(
      ['actors', 'move', '--name', 'Cube', '--location', 'z=200', '--project', project, '--json'],
      env
    )

    expect(result.exitCode).toBe(6)
    expect(payload(result.stdout).error.code).toBe('RISK_NOT_SUPPORTED')
    // 真的没动
    expect(level.actors.get('Cube')?.location).toBeUndefined()
  })

  it('tools call 那条入口同样挡', async () => {
    const { env, project } = await scene({ actors: [{ name: 'Cube' }] })

    const result = await run(
      ['tools', 'call', 'ue_destroy_actor', '--project', project, '--json'],
      env
    )

    expect(result.exitCode).toBe(6)
    expect(payload(result.stdout).error.hint).toContain('--allow-write')
  })

  /** 不说的话用户会以为盒子只开了只读工具，其实是 CLI 这头没开 */
  it('tools list 说明藏起来了几个写工具', async () => {
    const { env } = await scene()

    const result = await run(['tools', 'list', '--json'], env)
    const body = payload(result.stdout)

    expect(body.data.tools.map((tool: Json) => tool.name)).not.toContain('ue_spawn_actor')
    expect(body.warnings.join('')).toContain('--allow-write')
  })

  it('给了 --allow-write 就列出来，并标明哪些会改工程', async () => {
    const { env } = await scene()

    const result = await run(['tools', 'list', '--allow-write', '--json'], env)
    const tools = payload(result.stdout).data.tools as Array<Record<string, unknown>>

    expect(tools.find((t) => t.name === 'ue_spawn_actor')?.mutatesProject).toBe(true)
    expect(tools.find((t) => t.name === 'ue_get_actor')?.mutatesProject).toBe(false)
  })
})

describe('三条写命令走通', () => {
  it('actors move 改变换，并把回读结果作为凭据带回来', async () => {
    const { env, project, level } = await scene({
      actors: [{ name: 'Cube', location: { x: 0, y: 0, z: 0 } }]
    })

    const result = await run(
      [
        'actors',
        'move',
        '--name',
        'Cube',
        '--location',
        'z=200',
        '--allow-write',
        '--project',
        project,
        '--json'
      ],
      env
    )

    expect(result.exitCode).toBe(0)
    const body = payload(result.stdout)
    expect(body.data.verified.done).toBe(true)
    expect(body.data.actor.transform.location.z).toBe(200)
    expect(level.actors.get('Cube')?.location).toEqual({ x: 0, y: 0, z: 200 })
  })

  it('actors spawn 生成，回读查得到', async () => {
    const { env, project, level } = await scene()

    const result = await run(
      [
        'actors',
        'spawn',
        '--name',
        'MyCube',
        '--asset',
        'StaticMeshActor',
        '--location',
        '0,0,50',
        '--allow-write',
        '--project',
        project,
        '--json'
      ],
      env
    )

    expect(result.exitCode).toBe(0)
    expect(payload(result.stdout).data.verified.done).toBe(true)
    expect(level.actors.get('MyCube')?.location).toEqual({ x: 0, y: 0, z: 50 })
  })

  it('actors delete 删掉，回读查不到', async () => {
    const { env, project, level } = await scene({ actors: [{ name: 'Cube' }] })

    const result = await run(
      ['actors', 'delete', '--name', 'Cube', '--allow-write', '--project', project, '--json'],
      env
    )

    expect(result.exitCode).toBe(0)
    expect(payload(result.stdout).data.verified.done).toBe(true)
    expect(level.actors.has('Cube')).toBe(false)
  })

  /** 撤销办法要随成功一起给，不然用户得先去翻文档才能退回去（§12.5） */
  it('成功之后告诉用户怎么撤，并提醒撤销栈是共用的', async () => {
    const { env, project } = await scene({ actors: [{ name: 'Cube' }] })

    const result = await run(
      ['actors', 'delete', '--name', 'Cube', '--allow-write', '--project', project, '--json'],
      env
    )

    const warnings = payload(result.stdout).warnings.join('')
    expect(warnings).toContain('actors undo')
    expect(warnings).toContain('共用')
  })
})

describe('回读是唯一的判据', () => {
  /**
   * 这条是整套写操作的地基。
   *
   * 假盒子被设成「口头成功、什么都不做」——引擎那侧一个错都不报。没有回读
   * 那道关卡，CLI 会照着工具的自述报 success，调用方就在一个假前提上继续往下做。
   */
  it.each([
    ['move', ['actors', 'move', '--name', 'Cube', '--location', 'z=200']],
    ['delete', ['actors', 'delete', '--name', 'Cube']]
  ])('工具口头成功但状态没变时，%s 报失败而不是成功', async (_label, argv) => {
    const { env, project } = await scene({ actors: [{ name: 'Cube' }], sabotage: true })

    const result = await run([...argv, '--allow-write', '--project', project, '--json'], env)

    expect(result.exitCode).toBe(8)
    const error = payload(result.stdout).error
    expect(error.code).toBe('TOOL_FAILED')
    expect(error.hint).toContain('以回读为准')
  })

  it('生成也一样', async () => {
    const { env, project } = await scene({ sabotage: true })

    const result = await run(
      [
        'actors',
        'spawn',
        '--name',
        'Ghost',
        '--asset',
        'StaticMeshActor',
        '--allow-write',
        '--project',
        project,
        '--json'
      ],
      env
    )

    expect(result.exitCode).toBe(8)
    expect(payload(result.stdout).error.message).toContain('没有生成')
  })
})

describe('生成前先查重名', () => {
  /**
   * 引擎重名时会退让到 `MyCube_1`。名字被占着的时候，「MyCube 在不在」这个
   * 判据是坏的 —— 事后查到的那个可能是本来就有的。所以动手前先查一次。
   */
  it('名字已经被占用时直接拒绝，不去生成', async () => {
    const { env, project, level } = await scene({ actors: [{ name: 'MyCube' }] })

    const result = await run(
      [
        'actors',
        'spawn',
        '--name',
        'MyCube',
        '--asset',
        'StaticMeshActor',
        '--allow-write',
        '--project',
        project,
        '--json'
      ],
      env
    )

    expect(result.exitCode).toBe(2)
    expect(payload(result.stdout).error.message).toContain('已经有一个叫 MyCube')
    // 关键：没有偷偷生成一个 MyCube_1
    expect(level.actors.size).toBe(1)
    expect(level.actors.has('MyCube_1')).toBe(false)
  })
})

describe('P1-1：混用选择器不能绕过单对象限制', () => {
  const constrain = (tool: string, args: Record<string, unknown>): void => {
    admittedWrite(tool)!.constrain(args)
  }

  /**
   * 外部评审复现的三组参数，原来**全部放行**。
   *
   * 服务端把各路选择器并集处理（`destroyActor.ts` 里
   * `if (input.name) names.add(input.name)`），所以：
   *   - targets.names + name → 两个都删，而 CLI 只回读 targets 里那个，报成功
   *   - name + 字符串 targets → 字符串会被服务端 JSON.parse 成全关卡过滤器
   * 后果是静默多删，最坏是整个关卡。
   */
  it('targets.names 和 name 同时给 —— 拒', () => {
    expect(() => constrain('ue_destroy_actor', { targets: { names: ['A'] }, name: 'B' })).toThrow(
      /不能同时给 targets 和 name/
    )
  })

  /** 评审给的原样组合：name + 字符串 targets。两道检查任意一道挡下都算数 */
  it('name + 字符串形式的 targets —— 拒', () => {
    expect(() => constrain('ue_destroy_actor', { name: 'A', targets: '{"filter":{}}' })).toThrow(
      /不能同时给|必须是一个对象/
    )
  })

  /** 单独给字符串 targets 也要挡 —— 服务端会 JSON.parse 成全关卡过滤器 */
  it('只给字符串形式的 targets —— 拒', () => {
    expect(() => constrain('ue_destroy_actor', { targets: '{"filter":{}}' })).toThrow(
      /必须是一个对象/
    )
  })

  it.each(['path', 'paths', 'batch', 'filter', 'selection', 'instances'])(
    '顶层额外选择器 %s —— 拒',
    (key) => {
      expect(() =>
        constrain('ue_destroy_actor', { targets: { names: ['A'] }, [key]: 'X' })
      ).toThrow(/不支持/)
    }
  )

  /**
   * 光靠拒绝已知坏组合堵不住这类洞 —— 漏一个字段就是一个缺口，而服务端的
   * 兼容字段还会继续加。所以发出去的参数是重建的，只含白名单里的键。
   */
  it('发给引擎的是重建过的最小参数，调用方的多余键到不了', () => {
    const built = admittedWrite('ue_destroy_actor')!.payload({ targets: { names: ['A'] } })
    expect(built).toEqual({ targets: { names: ['A'] } })

    const moved = admittedWrite('ue_set_transform')!.payload({
      targets: { names: ['Cube'] },
      operation: { set: { location: { x: 1, y: 2, z: 3 }, 乱入: 1 }, space: 'Local' }
    })
    expect(moved).toEqual({
      targets: { names: ['Cube'] },
      operation: { set: { location: { x: 1, y: 2, z: 3 } } }
    })
  })

  /**
   * 端到端：走快捷命令时，混用参数进不去 —— `actors delete` 只认 `--name`，
   * 发出去的是重建过的最小参数。
   *
   * 这条原来测的是 `tools call`。那条路现在是**对等入口**：转发什么就发什么，
   * 不再按工具名分流到 `runWrite`（见 `commands/tools.ts` 的长注释）。
   * 原来的洞是「CLI 只回读了 A 却报成功」，也就是**声称核实了其实没有**；
   * 现在 `tools call` 一句核实都不声称，洞本身不存在了。真正声称核实的是
   * 快捷命令，所以这条断言跟着搬到它上面 —— 声称在哪，就守在哪。
   */
  it('端到端 —— 快捷命令只发重建过的参数，另一个 Actor 不受影响', async () => {
    const { env, project, level } = await scene({
      actors: [{ name: 'A' }, { name: 'B' }]
    })

    const result = await run(
      ['actors', 'delete', '--name', 'A', '--allow-write', '--project', project, '--json'],
      env
    )

    expect(result.exitCode).toBe(0)
    expect(level.actors.has('A')).toBe(false)
    expect(level.actors.has('B')).toBe(true)
  })

  /**
   * 对等入口确实是敞开的：同一组混用参数从 `tools call` 发出去会照原样到引擎。
   *
   * 这不是遗漏，是这条路的定义 —— 盒子自己的 agent 也是这么调的，CLI 不该更窄
   * 。代价写在返回值里：**没有 `verified` 字段**，
   * 调用方要自己看工具报了什么。
   */
  it('tools call 是对等入口 —— 原样转发，但不声称核实过', async () => {
    const { env, project, level } = await scene({
      actors: [{ name: 'A' }, { name: 'B' }]
    })

    const result = await run(
      [
        'tools',
        'call',
        'ue_destroy_actor',
        '--allow-write',
        '--project',
        project,
        '--args',
        JSON.stringify({ targets: { names: ['A'] }, name: 'B' }),
        '--json'
      ],
      env
    )

    expect(result.exitCode).toBe(0)
    // 参数原样到了引擎（`targets.names` 生效），而返回里没有 verified ——
    // 真服务端还会把顶层 `name` 并集处理掉 B，这个假盒子只认 targets，
    // 所以这里只断言「转发了」，不假装能证明并集那一步（§14 的教训）
    expect(level.actors.has('A')).toBe(false)
    expect(payload(result.stdout).data.verified).toBeUndefined()
  })
})

describe('P1-3：服务端先超时也要算「结局不明」', () => {
  /**
   * 外部评审抓到的：写工具内部只等引擎 60 秒，比 CLI 默认的 120 秒先到，
   * 所以真机上超时几乎总是走服务端这条路，而不是 CLI 自己的截止时间。
   *
   * 原来服务端把超时拍成一句普通错误，CLI 标成 `failed`。生成 Actor 的时候
   * 这条判断是致命的：Actor 可能已经生成了，调用方按「失败」重试就多出第二个。
   *
   * 现在服务端用 `_meta.unrealBox.errorCode = 'ENGINE_TIMEOUT'` 把超时这个
   * 事实传出来（见 src/main/agent-v3/tools/engineErrors.ts）。
   */
  const timedOutSpawn: FakeTool = {
    name: 'ue_spawn_actor',
    meta: { namespace: 'ue.actor', risk: 'mutating', projectScoped: true },
    handle: () => ({
      content: [{ type: 'text', text: 'ue_spawn_actor 失败：请求超时: actor.spawn (m-1)' }],
      isError: true,
      _meta: { unrealBox: { errorCode: 'ENGINE_TIMEOUT' } }
    })
  }

  it('服务端报 ENGINE_TIMEOUT 时，CLI 报「结局不明」而不是失败', async () => {
    const project = await projectDir()
    const level = fakeLevel()
    const box = await startFakeBox({
      token: TOKEN,
      tools: [
        healthTool(project),
        ...level.tools.filter((tool) => tool.name !== 'ue_spawn_actor'),
        timedOutSpawn
      ]
    })
    boxes.push(box)

    const result = await run(
      [
        'actors',
        'spawn',
        '--name',
        'Box1',
        '--asset',
        'StaticMeshActor',
        '--allow-write',
        '--project',
        project,
        '--json'
      ],
      { UEBOX_URL: box.url, UEBOX_TOKEN: TOKEN }
    )

    const error = payload(result.stdout).error
    // 7 = 超时，不是 8（引擎明确失败）
    expect(result.exitCode).toBe(7)
    expect(error.execution).toBe('unknown')
    // 关键：必须带回读命令，否则调用方只能猜
    expect(error.hint).toContain('uebox actors list --name "Box1"')
    expect(error.hint).toContain('不要重发')
  })
})

describe('P1-2：撤销必须真的撤得到 CLI 的改动', () => {
  async function undoScene(titles: string[]): Promise<{
    env: NodeJS.ProcessEnv
    project: string
    undo: ReturnType<typeof fakeUndoStack>
  }> {
    const project = await projectDir()
    const level = fakeLevel({ actors: [{ name: 'Cube' }] })
    const undo = fakeUndoStack(titles)
    const box = await startFakeBox({
      token: TOKEN,
      tools: [healthTool(project), ...level.tools, ...undo.tools]
    })
    boxes.push(box)
    return { env: { UEBOX_URL: box.url, UEBOX_TOKEN: TOKEN }, project, undo }
  }

  /**
   * 外部评审抓到的：CLI 的写入落在 agent 那条独立撤销栈上，事务结束时
   * `PopScope()` 把 `GEditor->Trans` 换回用户的缓冲。所以 Ctrl+Z 撤的是
   * **用户自己上一步**，CLI 的改动纹丝不动 —— 把人推向那个动作，等于既没回退、
   * 还毁掉他一次编辑。
   */
  it('成功提示指向 actors undo，并明确叫人别按 Ctrl+Z', async () => {
    const { env, project } = await scene({ actors: [{ name: 'Cube' }] })

    const result = await run(
      ['actors', 'delete', '--name', 'Cube', '--allow-write', '--project', project, '--json'],
      env
    )

    const warnings = payload(result.stdout).warnings.join('')
    expect(warnings).toContain('uebox actors undo')
    expect(warnings).toContain('不要在编辑器里按 Ctrl+Z')
  })

  it('撤一步，并拿撤销栈前后比对来核实', async () => {
    const { env, project, undo } = await undoScene(['生成 Box1', '移动 Cube'])

    const result = await run(
      ['actors', 'undo', '--allow-write', '--project', project, '--json'],
      env
    )

    expect(result.exitCode).toBe(0)
    const data = payload(result.stdout).data
    // 字段名点明它是描述而不是身份 —— 引擎的标题是写死的几个词
    expect(data.undoneStepDescription).toBe('移动 Cube')
    expect(data.remaining).toBe(1)
    expect(data.verified.done).toBe(true)
    expect(undo.stack).toEqual(['生成 Box1'])
  })

  /** 撤销只改内存，不说清楚用户会以为已经回退干净了 */
  it('提醒撤销还没落盘', async () => {
    const { env, project } = await undoScene(['移动 Cube'])

    const result = await run(
      ['actors', 'undo', '--allow-write', '--project', project, '--json'],
      env
    )

    expect(payload(result.stdout).warnings.join('')).toContain('磁盘上还是撤销前的样子')
  })

  it('栈是空的时候说清楚，而不是报一个含糊的失败', async () => {
    const { env, project } = await undoScene([])

    const result = await run(
      ['actors', 'undo', '--allow-write', '--project', project, '--json'],
      env
    )

    expect(result.exitCode).not.toBe(0)
    expect(payload(result.stdout).error.message).toContain('没有可撤销的步骤')
  })

  it('撤销同样要 --allow-write', async () => {
    const { env, project, undo } = await undoScene(['移动 Cube'])

    const result = await run(['actors', 'undo', '--project', project, '--json'], env)

    expect(result.exitCode).toBe(6)
    expect(undo.stack).toEqual(['移动 Cube'])
  })

  /**
   * `tools call ue_undo` 原来被挡下并指向 `actors undo`。门拆了之后它照常放行 ——
   * 对等入口不按工具名开例外。差别在**核实**：`actors undo` 会在撤销前后各读
   * 一次撤销栈，确认撤掉的确实是那一步；`tools call` 不读，也不声称读过。
   */
  it('tools call ue_undo 照常放行，只是不做前后比对', async () => {
    const { env, project, undo } = await undoScene(['移动 Cube'])

    const result = await run(
      ['tools', 'call', 'ue_undo', '--allow-write', '--project', project, '--json'],
      env
    )

    expect(result.exitCode).toBe(0)
    expect(undo.stack).toEqual([])
  })
})

describe('P1-4：同名事务下，撤销的判据只能是步数', () => {
  /**
   * 引擎的事务标题是写死的字面量（`UAL_ActorCommands.cpp` 里就是 `生成Actor`、
   * `删除Actor`），所以**连着生成两个 Actor，栈上就是两条一模一样的标题**。
   *
   * 原来的超时提示写着「栈顶标题没变 = 没撤成，可以重来」—— 在这个场景下
   * 它永远成立，照着做就会把另一个对象也撤掉。标题是描述，不是身份。
   */
  it('两条同名事务时，撤销成功不会因为标题没变而判成失败', async () => {
    const project = await projectDir()
    const level = fakeLevel()
    const undo = fakeUndoStack(['生成Actor', '生成Actor'])
    const box = await startFakeBox({
      token: TOKEN,
      tools: [healthTool(project), ...level.tools, ...undo.tools]
    })
    boxes.push(box)

    const result = await run(['actors', 'undo', '--allow-write', '--project', project, '--json'], {
      UEBOX_URL: box.url,
      UEBOX_TOKEN: TOKEN
    })

    expect(result.exitCode).toBe(0)
    expect(payload(result.stdout).data.remaining).toBe(1)
    expect(undo.stack).toEqual(['生成Actor'])
  })

  /** 超时提示里不能出现「按标题判断」，那会引导用户多撤一步 */
  it('超时提示按步数给判据，并明说不能看标题', async () => {
    const project = await projectDir()
    const level = fakeLevel()
    const box = await startFakeBox({
      token: TOKEN,
      tools: [
        healthTool(project),
        ...level.tools,
        {
          name: 'ue_undo_history',
          meta: { namespace: 'ue.editor', risk: 'safe', projectScoped: true },
          handle: () => ({
            content: [{ type: 'text', text: '2 步' }],
            structuredContent: {
              undoable: 2,
              redoable: 0,
              entries: [{ step: 1, title: '生成Actor', context: 'agent', packages: [] }]
            }
          })
        },
        {
          // 撤销请求一直不回，把 CLI 的截止时间耗光
          name: 'ue_undo',
          meta: { namespace: 'ue.editor', risk: 'destructive', projectScoped: true },
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 4000))
            return { content: [{ type: 'text', text: '晚了' }] }
          }
        }
      ]
    })
    boxes.push(box)

    const result = await run(
      ['actors', 'undo', '--allow-write', '--project', project, '--timeout', '2', '--json'],
      { UEBOX_URL: box.url, UEBOX_TOKEN: TOKEN }
    )

    expect(result.exitCode).toBe(7)
    const error = payload(result.stdout).error
    expect(error.execution).toBe('unknown')
    // 判据是步数
    expect(error.hint).toContain('撤之前是 2 步')
    expect(error.hint).toContain('变成 1 步')
    // 而且要明确挡住「看标题」这条错路
    expect(error.hint).toContain('不能看栈顶标题')
    expect(error.hint).not.toMatch(/栈顶还是「/)
  })
})

describe('P1-6：步数对不上不等于撤销失败', () => {
  /** 撤销成功之后、回读之前，别的客户端又往共用栈上加了一步 */
  function racingUndoTools(before: number, after: number, stepsApplied: number): FakeTool[] {
    let read = 0
    return [
      {
        name: 'ue_undo_history',
        meta: { namespace: 'ue.editor', risk: 'safe', projectScoped: true },
        handle: () => {
          const undoable = read++ === 0 ? before : after
          return {
            content: [{ type: 'text', text: `${undoable} 步` }],
            structuredContent: {
              undoable,
              redoable: 0,
              entries: [{ step: 1, title: '生成Actor', context: 'agent', packages: [] }]
            }
          }
        }
      },
      {
        name: 'ue_undo',
        meta: { namespace: 'ue.editor', risk: 'destructive', projectScoped: true },
        handle: () => ({
          content: [{ type: 'text', text: '撤了' }],
          structuredContent: {
            action: 'undo',
            stepsApplied,
            stepTitles: stepsApplied > 0 ? ['生成Actor'] : [],
            remaining: after,
            redoable: 1,
            affectedPackages: ['/Game/Maps/Main']
          }
        })
      }
    ]
  }

  async function raceScene(
    tools: FakeTool[]
  ): Promise<{ env: NodeJS.ProcessEnv; project: string }> {
    const project = await projectDir()
    const level = fakeLevel()
    const box = await startFakeBox({
      token: TOKEN,
      tools: [healthTool(project), ...level.tools, ...tools]
    })
    boxes.push(box)
    return { env: { UEBOX_URL: box.url, UEBOX_TOKEN: TOKEN }, project }
  }

  /**
   * 第二轮评审给的场景：撤之前 2 步 → 撤成功剩 1 步 → 别的客户端加 1 步 →
   * 回读又是 2 步。撤销明明生效了，深度却对不上。
   *
   * 原来一律报 TOOL_FAILED「撤销没有生效」，等于诱导调用方重试 ——
   * 而重试就是多撤一步。引擎已经给了正面证据（stepsApplied=1），
   * 我们只是没法确认最终状态，那就如实说「确认不了」。
   */
  it('引擎报告撤过了但步数被并发写入抵消 —— 报「无法确认」，不报失败', async () => {
    const { env, project } = await raceScene(racingUndoTools(2, 2, 1))

    const result = await run(
      ['actors', 'undo', '--allow-write', '--project', project, '--json'],
      env
    )

    const error = payload(result.stdout).error
    // 7 = 结局不明，不是 8（明确失败）
    expect(result.exitCode).toBe(7)
    expect(error.execution).toBe('unknown')
    expect(error.message).toContain('无法确认')
    // 保留引擎给的正面信息
    expect(error.message).toContain('已撤销 1 步')
    // 明确禁止重试，并点出并发这个最可能的原因
    expect(error.hint).toContain('不要直接重发')
    expect(error.hint).toContain('共用')
  })

  /** 引擎明说一步没撤 —— 那是确定的结论，可以报失败 */
  it('引擎报告一步没撤时才算失败', async () => {
    const { env, project } = await raceScene(racingUndoTools(2, 2, 0))

    const result = await run(
      ['actors', 'undo', '--allow-write', '--project', project, '--json'],
      env
    )

    expect(result.exitCode).toBe(8)
    expect(payload(result.stdout).error.execution).toBe('not_started')
  })

  /**
   * 最危险的一种组合：引擎说这次一步没撤，深度却真的少了一步 ——
   * 因为**别的客户端**先把那一步撤掉了。
   *
   * 原来 `stepsApplied === 0` 那条判断被写成 `!depthDropped && stepsApplied === 0`，
   * 于是这个组合两个分支都躲过去，一路掉到成功里，把别人干的事记在自己账上。
   * `stepsApplied` 是引擎对这一次调用的直接回答，不该由深度这种会被并发
   * 干扰的间接信号来开门。
   */
  it('引擎说没撤、深度却少了一步（别人撤的）—— 不许算自己成功', async () => {
    // 撤之前 2 步，撤之后 1 步（深度确实降了），但引擎说 stepsApplied = 0
    const { env, project } = await raceScene(racingUndoTools(2, 1, 0))

    const result = await run(
      ['actors', 'undo', '--allow-write', '--project', project, '--json'],
      env
    )

    const body = payload(result.stdout)
    expect(body.ok).toBe(false)
    expect(result.exitCode).toBe(8)
    expect(body.error.execution).toBe('not_started')
    // 并且要点出「那一步是别人撤的」这个可能
    expect(body.error.hint).toContain('别的客户端')
  })
})

describe('P1-5：服务端回读先超时也算「结局不明」', () => {
  /**
   * `ue_get_actor` 原来也把超时压成普通错误。于是「写成功了、回读没确认上」
   * 这条路径仍然会被报成 failed —— 我上一轮专门为它写的分支根本走不到，
   * 因为服务端 60 秒先于 CLI 的 120 秒到。
   */
  it('写成功后回读被服务端报超时，仍然是 unknown 并给回读命令', async () => {
    const project = await projectDir()
    const level = fakeLevel({ actors: [{ name: 'Cube' }] })
    const box = await startFakeBox({
      token: TOKEN,
      tools: [
        healthTool(project),
        ...level.tools.filter((tool) => tool.name !== 'ue_get_actor'),
        {
          name: 'ue_get_actor',
          meta: { namespace: 'ue.actor', risk: 'safe', projectScoped: true },
          handle: () => ({
            content: [{ type: 'text', text: '请求超时: actor.get (m-9)' }],
            isError: true,
            _meta: { unrealBox: { errorCode: 'ENGINE_TIMEOUT' } }
          })
        }
      ]
    })
    boxes.push(box)

    const result = await run(
      ['actors', 'delete', '--name', 'Cube', '--allow-write', '--project', project, '--json'],
      { UEBOX_URL: box.url, UEBOX_TOKEN: TOKEN }
    )

    expect(result.exitCode).toBe(7)
    const error = payload(result.stdout).error
    expect(error.execution).toBe('unknown')
    expect(error.hint).toContain('uebox actors list --name "Cube"')
  })
})

describe('评审抓到的三处', () => {
  /**
   * 这句提示错过两次，两次错法不同，所以两条都要钉住：
   *
   * 第一版：「跑 uebox tools call ue_undo --allow-write」—— 必然被准入表挡下。
   * 第二版：「在编辑器里按 Ctrl+Z」—— 更糟，它撤的是用户自己上一步。
   */
  it('两种错过的撤销说法都不再出现', async () => {
    const { env, project } = await scene({ actors: [{ name: 'Cube' }] })

    const result = await run(
      ['actors', 'delete', '--name', 'Cube', '--allow-write', '--project', project, '--json'],
      env
    )

    const warnings = payload(result.stdout).warnings.join('')
    expect(warnings).not.toContain('call ue_undo --allow-write')
    // 只能出现在「不要按」那句里
    expect(warnings).toContain('不要在编辑器里按 Ctrl+Z')
  })

  /** ue_undo 走单独一条命令，不进按 Actor 建模的那张表 */
  it('ue_undo 不在 Actor 写操作表里，但确实准入了', () => {
    expect(admittedWrite('ue_undo')).toBeUndefined()
    expect(ADMITTED_WRITE_TOOLS).not.toContain('ue_undo')
  })

  /**
   * 回读那一步原来在 try 外面：它超时的话，用户拿到的是一句没有上下文的
   * 「超时」，完全看不出写操作已经发出去、而且多半已经生效了。
   *
   * 这条路径比「请求超时」更要紧 —— 工具已经回了成功，改动大概率落下了，
   * 讲成「不知道做没做」会让人白重发一次。
   */
  it('写成功但回读超时时，说清楚是回读没确认上，并给回读命令', async () => {
    const { env, project, level } = await scene({
      actors: [{ name: 'Cube' }],
      readbackDelayMs: 4000
    })

    const result = await run(
      [
        'actors',
        'delete',
        '--name',
        'Cube',
        '--allow-write',
        '--project',
        project,
        '--timeout',
        '2',
        '--json'
      ],
      env
    )

    expect(result.exitCode).toBe(7)
    const error = payload(result.stdout).error
    expect(error.execution).toBe('unknown')
    expect(error.message).toContain('回读超时')
    // 核实办法照给，而且是删除那条的读法
    expect(error.hint).toContain('uebox actors list --name "Cube"')
    expect(error.hint).toContain('查不到 = 已经删掉')
    // 而它其实真的删掉了 —— 正是「报失败会误导」的那种情况
    expect(level.actors.has('Cube')).toBe(false)
  })

  /**
   * 盒子把一个 `ue.*` 写工具报成非 projectScoped 时，`tools call` 会照它说的
   * 不带工程路径发出去。
   *
   * 原来这里报 PROJECT_NOT_CONNECTED，因为 `runWrite` 没有工程就无从回读。
   * 现在 `tools call` 不走 runWrite，也就没有这个前提；元数据说不需要工程，
   * CLI 没有第二个信息源去反驳它。**守住的是不撒谎**：这条路径一句核实都不
   * 声称，调用方拿到的是工具自己报的东西。
   *
   * 要 CLI 替你核实就走快捷命令（`actors delete`），那条会强制定下工程。
   */
  it('盒子说不需要工程时就不带工程发，且不声称核实过', async () => {
    const project = await projectDir()
    const level = fakeLevel({ actors: [{ name: 'Cube' }] })
    // 盒子把写工具报成非 projectScoped —— 触发那个组合
    const tools = level.tools.map((tool) =>
      tool.name === 'ue_destroy_actor'
        ? { ...tool, meta: { ...tool.meta!, projectScoped: false } }
        : tool
    )
    const box = await startFakeBox({ token: TOKEN, tools: [healthTool(project), ...tools] })
    boxes.push(box)

    const result = await run(['tools', 'call', 'ue_destroy_actor', '--allow-write', '--json'], {
      UEBOX_URL: box.url,
      UEBOX_TOKEN: TOKEN
    })

    expect(result.exitCode).toBe(0)
    // 关键：没有 verified 字段 —— CLI 没核实，也就不许摆出核实过的样子
    expect(payload(result.stdout).data.verified).toBeUndefined()
  })
})

describe('--location 的写法', () => {
  it('三个数按顺序', async () => {
    const { env, project, level } = await scene({ actors: [{ name: 'Cube' }] })

    await run(
      [
        'actors',
        'move',
        '--name',
        'Cube',
        '--location',
        '10,20,30',
        '--allow-write',
        '--project',
        project,
        '--json'
      ],
      env
    )

    expect(level.actors.get('Cube')?.location).toEqual({ x: 10, y: 20, z: 30 })
  })

  /** 只想抬高一点的时候，不该逼用户先查一次当前坐标再原样填回去 */
  it('具名形式只动给了的那个分量', async () => {
    const { env, project, level } = await scene({
      actors: [{ name: 'Cube', location: { x: 7, y: 8, z: 9 } }]
    })

    await run(
      [
        'actors',
        'move',
        '--name',
        'Cube',
        '--location',
        'z=200',
        '--allow-write',
        '--project',
        project,
        '--json'
      ],
      env
    )

    expect(level.actors.get('Cube')?.location).toEqual({ x: 7, y: 8, z: 200 })
  })

  it('数量不对时报参数错并给出具名写法', async () => {
    const { env, project } = await scene({ actors: [{ name: 'Cube' }] })

    const result = await run(
      [
        'actors',
        'move',
        '--name',
        'Cube',
        '--location',
        '1,2',
        '--allow-write',
        '--project',
        project,
        '--json'
      ],
      env
    )

    expect(result.exitCode).toBe(2)
    expect(payload(result.stdout).error.hint).toContain('z=200')
  })
})
