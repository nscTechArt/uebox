/**
 * `tools call` 的参数输入。
 *
 * ## 为什么力推参数文件
 *
 * PowerShell、cmd、bash 对引号和 `{}` 的处理各不相同，同一段 JSON 在三个 shell
 * 里要写三遍。文件绕开这件事，代价只是多一个文件。
 *
 * ## 这一层只校验语法，不校验业务
 *
 * 「是不是合法 JSON」「是不是对象」在这里判；「这个字段该是什么类型」「有没有
 * 必填项」交给服务端已有的 Zod 校验。在 CLI 里再实现一套 schema 解释器，
 * 结果一定是两套规则各说各话，而漂移出来的表现是「CLI 说参数对，引擎说不对」。
 */

import { promises as fs } from 'node:fs'

import { stripBom } from './config.js'
import { UeboxError } from './errors.js'

/** 文件和标准输入的上限。超过它多半是喂错了东西，不是真有这么大的参数 */
export const MAX_ARGS_BYTES = 1024 * 1024

export interface ArgsInput {
  args?: string
  argsFile?: string
}

/**
 * 解出这次调用的参数对象。
 *
 * 两种输入都不给时返回 `{}` —— 不少工具本来就不需要参数。
 */
export async function readToolArgs(input: ArgsInput): Promise<Record<string, unknown>> {
  if (input.args !== undefined) return parseObject(input.args, '--args')

  if (input.argsFile !== undefined) {
    const text = input.argsFile === '-' ? await readStdin() : await readFileCapped(input.argsFile)
    return parseObject(text, input.argsFile === '-' ? '标准输入' : input.argsFile)
  }

  return {}
}

async function readFileCapped(path: string): Promise<string> {
  let raw: Buffer
  try {
    raw = await fs.readFile(path)
  } catch {
    throw new UeboxError('INVALID_ARGUMENT', `读不到参数文件：${path}`)
  }
  if (raw.byteLength > MAX_ARGS_BYTES) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      `参数文件超过 ${MAX_ARGS_BYTES} 字节：${path}（${raw.byteLength} 字节）`
    )
  }
  return stripBom(raw.toString('utf8'))
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_ARGS_BYTES) {
      throw new UeboxError('INVALID_ARGUMENT', `标准输入超过 ${MAX_ARGS_BYTES} 字节。`)
    }
    chunks.push(buffer)
  }

  return stripBom(Buffer.concat(chunks).toString('utf8'))
}

function parseObject(text: string, where: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new UeboxError('INVALID_ARGUMENT', `${where} 是空的。不需要参数就整个别给。`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new UeboxError('INVALID_ARGUMENT', `${where} 不是合法 JSON：${(error as Error).message}`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      `${where} 必须是一个 JSON 对象，收到 ${Array.isArray(parsed) ? '数组' : typeof parsed}。`
    )
  }

  return parsed as Record<string, unknown>
}
