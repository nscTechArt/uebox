import { describe, expect, it, vi } from 'vitest'

// credentials.ts 顶层 import 了 electron，单测环境里没有真实 app / safeStorage
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

const { parseApiKeyInput } = await import('./credentials')

/**
 * 三种密钥形态共用一个输入框，全靠这个函数区分。
 *
 * 判错的后果不对称：把命令当成密钥只是调用时报错；把密钥当成环境变量名，
 * 用户的密钥就被当作变量名存进了 models.json 明文里。所以这里逐条钉住。
 */
describe('parseApiKeyInput', () => {
  it('! 开头是命令', () => {
    expect(parseApiKeyInput('!op read op://vault/openai/key')).toEqual({
      kind: 'shell',
      command: 'op read op://vault/openai/key'
    })
  })

  it('! 与命令之间的空格不影响', () => {
    expect(parseApiKeyInput('!  echo hi ')).toEqual({ kind: 'shell', command: 'echo hi' })
  })

  it('只有一个 ! 视为空输入', () => {
    expect(parseApiKeyInput('!')).toBeNull()
  })

  it('全大写下划线是环境变量名', () => {
    expect(parseApiKeyInput('OPENAI_API_KEY')).toEqual({ kind: 'env', name: 'OPENAI_API_KEY' })
    expect(parseApiKeyInput('DASHSCOPE_API_KEY2')).toEqual({
      kind: 'env',
      name: 'DASHSCOPE_API_KEY2'
    })
  })

  it('真实密钥不会被误判成环境变量名', () => {
    // 这是最危险的一条：误判会把密钥明文写进 models.json 当变量名
    for (const key of [
      'sk-proj-abc123',
      'sk-ant-api03-XYZ',
      'AIzaSyD-abcdef',
      'ABC-DEF',
      'ABCdef'
    ]) {
      expect(parseApiKeyInput(key)).toEqual({ kind: 'literal', value: key })
    }
  })

  it('空白与空串都返回 null，交给调用方决定沿用还是清空', () => {
    expect(parseApiKeyInput('')).toBeNull()
    expect(parseApiKeyInput('   ')).toBeNull()
  })

  it('前后空格会被去掉', () => {
    expect(parseApiKeyInput('  sk-abc  ')).toEqual({ kind: 'literal', value: 'sk-abc' })
  })
})
