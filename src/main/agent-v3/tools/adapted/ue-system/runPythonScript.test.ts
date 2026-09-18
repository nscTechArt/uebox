import { describe, expect, it, vi } from 'vitest'
import { adaptV2Tool } from '../../adaptV2Tool'
import { createRunPythonScriptTool } from './runPythonScript'

vi.mock('../../../core/editorPython', () => ({
  runEditorPython: vi.fn().mockResolvedValue({
    success: false,
    error: '布尔失败',
    stdout: 'source_closed=False; before=2'
  })
}))
vi.mock('../../builtin/pathBoundary', () => ({ assertScriptAllowed: () => undefined }))

describe('ue_run_python_script', () => {
  it('经过真实适配器后模型仍能看到失败前的回读诊断', async () => {
    const tool = adaptV2Tool(createRunPythonScriptTool(), {
      name: 'ue_run_python_script',
      namespace: 'ue-system',
      risk: 'destructive'
    })
    await expect(tool.execute('test', { script: 'pass' })).rejects.toThrow(
      'source_closed=False; before=2'
    )
  })
})
