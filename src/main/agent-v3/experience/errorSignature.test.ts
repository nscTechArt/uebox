import { describe, expect, it } from 'vitest'

import { errorFingerprint, isEnvironmentalError, normalizeError } from './errorSignature'

// 样本照真实报错的形状写，路径和名字换成了虚构的
describe('isEnvironmentalError', () => {
  it.each([
    'ue_save 失败：请求超时: editor.save (2c2de2a1-43fb-4a8e-a267-c0791bba6039)',
    'ue_get_actor 失败：请求超时: actor.get_info (78eb93d1-d638-4805-a5e0-104e6316e41a)（错误码 E_TIMEOUT）',
    '没有可用的客户端连接',
    'blueprint_compile 失败：No Unreal Editor connection is available.',
    'Operation aborted',
    '以下资产正被**盒子里的另一条 AI 对话**修改中，本次调用未做任何改动',
    '以下资产正被盒子里的另一条 AI 会话占着',
    'Validation failed for tool "ue_get_actor": - root: must not have additional properties',
    'Tool ue_run_python_script not found',
    'net::ERR_CONNECTION_CLOSED',
    '生图接口报错 HTTP 403：user quota is not enough'
  ])('环境噪声不学：%s', (text) => {
    expect(isEnvironmentalError(text)).toBe(true)
  })

  it.each([
    "ue_run_python_script 失败：Traceback (most recent call last): File \"<ua-script>\", line 5, in <module> AttributeError: 'Character' object has no attribute 'is_hidden' 详情：{}",
    "blueprint_apply_graph 失败：整批已回滚。 1. connections[3]: pin 'AsPlayer Controller' not found on 'castPC'",
    'blueprint_compile 失败：蓝图编译未通过（状态 Error）。 - [Error] Target Array 的类型尚未确定。',
    '/Game/UI/WBP_Card：File is read-only on disk (checked out to someone else)'
  ])('真知识要学：%s', (text) => {
    expect(isEnvironmentalError(text)).toBe(false)
  })
})

describe('normalizeError', () => {
  it('Python traceback 只留最后那行异常，属性名原样保留', () => {
    const text =
      'ue_run_python_script 失败：Traceback (most recent call last): File "<string>", line 2, in <module> ' +
      "File \"<ua-script>\", line 9, in <module> AttributeError: 'Character' object has no attribute 'is_hidden' 详情：{}"
    expect(normalizeError(text)).toBe(
      "attributeerror: 'character' object has no attribute 'is_hidden'"
    )
  })

  it('抹掉 GUID、资产路径、磁盘路径和数字', () => {
    const a = normalizeError(
      'blueprint_delete_node 失败：Node not found with ID: 2CF6CAFA-4184-0E09-681C-48914BE09998 in /Game/BP/BP_Door'
    )
    const b = normalizeError(
      'blueprint_delete_node 失败：Node not found with ID: 11111111-2222-3333-4444-555555555555 in /Game/Other/BP_Gate'
    )
    expect(a).toBe(b)
    expect(a).toBe('node not found with id: <id> in <path>')
    expect(normalizeError('writing I:/Game/Proj/Saved/Config/x.ini failed at line 42')).toBe(
      'writing <path> failed at line <n>'
    )
  })

  it('指纹只取开头一段，批量报错顺序变了也认得出是同一类', () => {
    const fp = errorFingerprint(`ue_save 失败：File is read-only on disk ${'x'.repeat(300)}`)
    expect(fp.length).toBeLessThanOrEqual(120)
    expect(fp.startsWith('file is read-only on disk')).toBe(true)
  })
})
