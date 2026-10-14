/** @vitest-environment node */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readCrashFolder } from './crashFolder'

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'uebox-crashfolder-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function crashFolder(fields: Record<string, string>, log?: string): string {
  const dir = path.join(root, 'UECC-Windows-ABC')
  mkdirSync(dir, { recursive: true })
  const body = Object.entries(fields)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('\n')
  writeFileSync(
    path.join(dir, 'CrashContext.runtime-xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<FGenericCrashContext><RuntimeProperties>${body}</RuntimeProperties></FGenericCrashContext>`
  )
  if (log !== undefined) writeFileSync(path.join(dir, 'MyGame.log'), log)
  return dir
}

describe('崩溃目录', () => {
  /**
   * 原因常在崩溃前：先有一条资产加载失败，几秒后才是空指针。
   * 以前这里只回「详情请查看完整日志文件」，模型拿不到这一段。
   */
  it('带回目录里那份当次日志的尾巴', () => {
    const log = [
      'LogInit: start',
      'LogStreaming: Error: Failed to load /Game/Missing',
      'Fatal'
    ].join('\r\n')
    const facts = readCrashFolder(
      crashFolder({ CrashType: 'Crash', ErrorMessage: 'Access violation' }, log)
    )

    expect(facts!.kind).toBe('fatal')
    expect(facts!.logTail).toContain('Failed to load /Game/Missing')
    expect(facts!.logFile).toMatch(/MyGame\.log$/)
  })

  it('日志很长时只留最后几十行，开头被截断的半行丢掉', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `LogTemp: line ${i}`)
    const facts = readCrashFolder(crashFolder({ CrashType: 'Crash' }, lines.join('\n')))

    expect(facts!.logTail).toContain('line 4999')
    expect(facts!.logTail).not.toContain('line 0\n')
    expect(facts!.logTail.split('\n').length).toBeLessThanOrEqual(80)
  })

  it('目录里没有日志时尾巴为空，不编', () => {
    const facts = readCrashFolder(crashFolder({ CrashType: 'Crash' }))

    expect(facts!.logTail).toBe('')
    expect(facts!.logFile).toBeUndefined()
  })

  it('ensure 和卡顿不算崩溃', () => {
    expect(readCrashFolder(crashFolder({ CrashType: 'Ensure', IsEnsure: 'true' }))!.kind).toBe(
      'ensure'
    )
  })

  it('卡顿单独归类', () => {
    expect(readCrashFolder(crashFolder({ CrashType: 'Stall' }))!.kind).toBe('stall')
  })

  /** 全是 UnknownFunction 说明没装调试符号；这是事实，判断留给模型 */
  it('数出调用栈里没解析出函数名的帧', () => {
    const facts = readCrashFolder(
      crashFolder({
        CrashType: 'Crash',
        CallStack:
          'UnrealEditor-Engine.dll!UnknownFunction []\nUnrealEditor-Core.dll!UnknownFunction []'
      })
    )

    expect(facts!.frames).toEqual({ total: 2, unresolved: 2 })
  })

  it('GPU 崩溃附上该怎么读，因为调用栈看不出 GPU 上出了什么事', () => {
    const facts = readCrashFolder(crashFolder({ CrashType: 'GPUCrash' }))

    expect(facts!.crashType).toBe('GPUCrash')
    expect(facts!.note).toContain('GPU')
  })

  it('普通崩溃没有附加说明', () => {
    expect(readCrashFolder(crashFolder({ CrashType: 'Crash' }))!.note).toBeUndefined()
  })

  it('没有 CrashContext 的目录返回 null', () => {
    const dir = path.join(root, 'empty')
    mkdirSync(dir)
    expect(readCrashFolder(dir)).toBeNull()
  })
})
