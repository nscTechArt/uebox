/**
 * 读一个崩溃目录（`Saved/Crashes/<GUID>/`），翻成模型能直接用的事实。
 *
 * 独立成模块是为了能直接测：工具文件里混着 electron 和 WebSocket，这里只有文件读取。
 *
 * ## 为什么要带上目录里的那份日志
 *
 * 引擎崩溃时会把当次会话的日志复制一份进崩溃目录（`<工程名>.log`）。真正的原因常在
 * 崩溃之前，比如先有一条资产加载失败，几秒后才是空指针。以前这里只回一句
 * 「详情请查看完整日志文件」，模型只好去读 `Saved/Logs` 里最新的那份。可编辑器一重启，
 * 那就已经是新会话的日志了，崩溃前的线索不在里面。
 *
 * ## 为什么要分类
 *
 * 同一个目录里还有 ensure 和卡顿的报告，那时编辑器还活着。把它们当崩溃报给用户，
 * 用户会去查一个不存在的崩溃。GPU 崩溃的调用栈停在提交命令的那一行，看不出
 * GPU 上出了什么事；对着它分析只会编出一个原因。
 */

import * as fs from 'fs'
import * as path from 'path'

import { decodeUeText } from '../../../../utils/ueTextFile'
import {
  crashContextField,
  crashKind,
  type CrashKind
} from '../../../../services/editorCrashWatch/crashReport'

/** 日志尾巴最多读多少字节、留多少行。原因一般在崩溃前几十行内 */
const LOG_TAIL_BYTES = 16 * 1024
const LOG_TAIL_LINES = 80

export interface CrashFolderFacts {
  kind: CrashKind
  /** 引擎自己写的 `CrashType`（`Crash` / `Assert` / `GPUCrash` / `OutOfMemory` …），老版本可能为空 */
  crashType: string
  error: string
  callStack: string
  /** 调用栈一共几帧、其中几帧没解析出函数名。全是没解析出来的，说明缺调试符号 */
  frames: { total: number; unresolved: number }
  /** 崩溃目录里那份日志的最后几十行；目录里没有日志时为空 */
  logTail: string
  logFile?: string
  /** 只针对引擎明确报出的类型，说清这类崩溃该怎么读 */
  note?: string
}

/** 引擎给的 CrashType → 该怎么读。只写引擎自己报出来的类型，不从调用栈去猜 */
const TYPE_NOTES: Record<string, string> = {
  gpucrash:
    'GPU 崩溃：调用栈只停在 CPU 提交命令的位置，看不出 GPU 上出了什么问题，不要据此推断原因。' +
    '要定位，请用户加启动参数 -gpucrashdebugging 复现一次，再看新的崩溃日志。',
  outofmemory:
    '内存不足：调用栈只是最后一次申请内存的位置，不一定是元凶。先看日志尾巴里内存的走势。'
}

function readLogTail(folder: string): { text: string; file?: string } {
  const log = fs
    .readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.log'))
    .map((name) => path.join(folder, name))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
  if (!log) return { text: '' }

  const size = fs.statSync(log).size
  const readSize = Math.min(size, LOG_TAIL_BYTES)
  const buffer = Buffer.alloc(readSize)
  const fd = fs.openSync(log, 'r')
  try {
    fs.readSync(fd, buffer, 0, readSize, size - readSize)
  } finally {
    fs.closeSync(fd)
  }
  const lines = decodeUeText(buffer).split(/\r?\n/)
  // 从文件中间截断时第一行是半截，丢掉
  if (readSize < size) lines.shift()
  return { text: lines.slice(-LOG_TAIL_LINES).join('\n').trim(), file: log }
}

/** 读不出 `CrashContext.runtime-xml` 时返回 null */
export function readCrashFolder(folder: string): CrashFolderFacts | null {
  const xmlPath = path.join(folder, 'CrashContext.runtime-xml')
  if (!fs.existsSync(xmlPath)) return null
  const xml = decodeUeText(fs.readFileSync(xmlPath))

  const callStack = crashContextField(xml, 'CallStack')
  const frames = callStack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const crashType = crashContextField(xml, 'CrashType')
  const log = readLogTail(folder)

  return {
    kind: crashKind(xml),
    crashType,
    error: crashContextField(xml, 'ErrorMessage'),
    callStack,
    frames: {
      total: frames.length,
      unresolved: frames.filter((line) => line.includes('UnknownFunction')).length
    },
    logTail: log.text,
    logFile: log.file,
    note: TYPE_NOTES[crashType.toLowerCase()]
  }
}
