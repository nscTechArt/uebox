import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adaptV2Tool } from '../../adaptV2Tool'
import { createRunPythonScriptTool } from './runPythonScript'
import { runEditorPython } from '../../../core/editorPython'
import { lastViewportMove, resetViewportProvenance } from '../ue-editor/viewportProvenance'

vi.mock('../../../core/editorPython', () => ({ runEditorPython: vi.fn() }))
vi.mock('../../builtin/pathBoundary', () => ({ assertScriptAllowed: () => undefined }))

// skill 脚本从临时目录里读：一个正常的，一个带位置参数 Rotator 的
const skillDir = mkdtempSync(join(tmpdir(), 'run-python-skill-'))
mkdirSync(join(skillDir, 'scripts'), { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: doubao-motion-import\ndescription: x\n---\n')
writeFileSync(join(skillDir, 'scripts', 'import.py'), 'print("from disk")\n')
writeFileSync(join(skillDir, 'scripts', 'bad_rotator.py'), 'r = unreal.Rotator(0, 90, 0)\n')
afterAll(() => rmSync(skillDir, { recursive: true, force: true }))
vi.mock('../../../capabilities/skills', () => ({
  discoverEnabledSkills: async () => [
    { name: 'doubao-motion-import', description: 'x', path: skillDir, source: 'project' }
  ]
}))

const mockRun = vi.mocked(runEditorPython)

const adapted = (): ReturnType<typeof adaptV2Tool> =>
  adaptV2Tool(createRunPythonScriptTool(), {
    name: 'ue_run_python_script',
    namespace: 'ue-system',
    risk: 'destructive'
  })

/** 失败走 isError 那条路，适配器会抛出来 —— 接住拿文本 */
const errorTextOf = async (input: unknown): Promise<string> => {
  try {
    await adapted().execute('test', input)
    return '(没有抛出)'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

beforeEach(() => {
  mockRun.mockReset()
  resetViewportProvenance()
})

describe('ue_run_python_script', () => {
  it('经过真实适配器后模型仍能看到失败前的回读诊断', async () => {
    mockRun.mockResolvedValue({
      success: false,
      error: '布尔失败',
      stdout: 'source_closed=False; before=2'
    })
    await expect(adapted().execute('test', { script: 'pass' })).rejects.toThrow(
      'source_closed=False; before=2'
    )
  })

  /**
   * 排查指引只该出现在「没确认上」那一档。
   *
   * 脚本自己抛异常时，下一步是改脚本再跑；而超时/丢结果时连「跑没跑」都不知道，
   * 重发可能把同一个修改做两遍。两种情况给同一段话，等于把「别重发」这个最要紧的
   * 提示稀释掉。指引拼在这一层而不是 runEditorPython 里，是因为那个 error
   * 还有两条路会原样弹给用户看，而这段话点名了一个用户调不到的工具。
   */
  it('没确认上时补排查指引', async () => {
    mockRun.mockResolvedValue({
      success: false,
      unconfirmed: true,
      error: 'Python 执行未确认（改材质）：timeout。请先回读，勿重复执行修改。'
    })

    const text = await errorTextOf({ script: 'pass' })
    expect(text).toContain('ue_session_health')
    expect(text).toContain('不要再发命令试探')
  })

  it('脚本自己报错时不补排查指引', async () => {
    mockRun.mockResolvedValue({
      success: false,
      error: 'NameError: name “foo” is not defined'
    })

    const text = await errorTextOf({ script: 'foo()' })
    expect(text).toContain('NameError')
    expect(text).not.toContain('ue_session_health')
  })

  /**
   * unreal.Rotator 的位置参数顺序是 (roll, pitch, yaw)，按 (pitch, yaw, roll) 写会静默转错方向。
   * 真机上 78 个部件因此全摆错 —— 这里必须在发给引擎之前拦下来，一个字都不能执行。
   */
  it('unreal.Rotator 用位置参数时拒绝执行，并告诉模型改成关键字', async () => {
    const text = await errorTextOf({
      script: 'a = unreal.Rotator(0.0, 90.0, 0.0)'
    })
    expect(mockRun).not.toHaveBeenCalled()
    expect(text).toContain('(roll, pitch, yaw)')
    expect(text).toContain('unreal.Rotator(roll=0.0, pitch=0.0, yaw=90.0)')
  })

  it('关键字写法照常执行', async () => {
    mockRun.mockResolvedValue({ success: true, stdout: 'ok' })
    await adapted().execute('test', { script: 'a = unreal.Rotator(roll=0, pitch=0, yaw=90)' })
    expect(mockRun).toHaveBeenCalledTimes(1)
  })

  /** 脚本动了用户的视口相机，ue_screenshot 拍视口时要能说出「最后是这次脚本动的」 */
  it('脚本调了视口相机 API 就记一笔', async () => {
    mockRun.mockResolvedValue({ success: true, stdout: 'ok' })
    await adapted().execute('test', {
      script: 'ues.set_level_viewport_camera_info(loc, unreal.Rotator(roll=0, pitch=0, yaw=90))'
    })
    expect(lastViewportMove()).toMatchObject({
      tool: 'ue_run_python_script',
      detail: '脚本里调了 set_level_viewport_camera_info'
    })
  })

  it('普通脚本不记视口', async () => {
    mockRun.mockResolvedValue({ success: true, stdout: 'ok' })
    await adapted().execute('test', { script: 'print(1)' })
    expect(lastViewportMove()).toBeNull()
  })

  /** 用户自己按的停止，不是引擎卡了 —— 不能冲他喊「请重启编辑器」 */
  it('中止时按 aborted 处理，不补排查指引', async () => {
    mockRun.mockResolvedValue({
      success: false,
      aborted: true,
      unconfirmed: true,
      error: '已停止等待（改材质）：已停止等待。编辑器里的脚本可能仍在执行，先回读再操作。'
    })

    const text = await errorTextOf({ script: 'pass' })
    expect(text).toContain('先回读再操作')
    expect(text).not.toContain('请用户重启编辑器')
  })
})

/**
 * 按路径跑 skill 自带的脚本。
 *
 * 守的是：跑的是盘上那一份（正文不经过模型转抄），参数以 SKILL_ARGS 进去，
 * 而且 skill 脚本和手写脚本过同一套检查。
 */
describe('跑 skill 自带的脚本', () => {
  it('读盘上的脚本，前面接上 SKILL_ARGS', async () => {
    mockRun.mockResolvedValue({ success: true, stdout: 'ok' })
    await adapted().execute('test', {
      skill: 'doubao-motion-import',
      skill_script: 'scripts/import.py',
      args: { source_dir: 'G:/动作\\新版', overwrite: true }
    })

    const sent = mockRun.mock.calls[0][0]
    expect(sent).toContain('SKILL_ARGS = _skill_json.loads(')
    expect(sent).toContain('print("from disk")')
    // 中文、反斜杠原样到得了 Python：拿同一套 JSON 规则解回来验
    const literal = sent.match(/loads\((".*")\)/)![1]
    expect(JSON.parse(JSON.parse(literal))).toEqual({
      source_dir: 'G:/动作\\新版',
      overwrite: true
    })
  })

  it('script 和 skill 脚本不能同时给，也不能都不给', async () => {
    expect(
      await errorTextOf({
        script: 'pass',
        skill: 'doubao-motion-import',
        skill_script: 'scripts/import.py'
      })
    ).toContain('二选一')
    expect(await errorTextOf({})).toContain('二选一')
    expect(mockRun).not.toHaveBeenCalled()
  })

  it('只收 scripts/ 下的 .py', async () => {
    expect(
      await errorTextOf({ skill: 'doubao-motion-import', skill_script: 'references/notes.md' })
    ).toContain('scripts/')
  })

  it('skill 脚本同样过旋转检查', async () => {
    expect(
      await errorTextOf({ skill: 'doubao-motion-import', skill_script: 'scripts/bad_rotator.py' })
    ).toContain('Rotator')
    expect(mockRun).not.toHaveBeenCalled()
  })
})
