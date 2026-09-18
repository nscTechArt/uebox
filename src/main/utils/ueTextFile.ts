// 用命名空间导入 + `fs.promises.readFile`，不要改成 `import { promises } from 'fs'`：
// 后者在 vitest 里绑的是真实的 builtin，测试里的 vi.mock('fs') 盖不住它
import * as fs from 'fs'

/**
 * 引擎写出来的文本文件（`.uproject` / `.uplugin` / `.ini` / 启动器清单）统一从这里读。
 *
 * ## 为什么不能直接 `readFile(path, 'utf-8')`
 *
 * UE 保存描述文件走的是 `FFileHelper::SaveStringToFile(Text, *FileName)`，第三个参数
 * 默认是 `EEncodingOptions::AutoDetect`（`ProjectDescriptor.cpp` / `PluginDescriptor.cpp`，
 * 5.0–5.8 全一样）。AutoDetect 的判据只有一条：
 *
 *   `!FCString::IsPureAnsi(...)` → 存成 **UTF-16LE 带 BOM**（`FileHelper.cpp:681`）。
 *
 * 也就是说，只要 `.uproject` 里出现一个非 ASCII 字符 —— 中文工程名、中文 Description、
 * 中文作者名 —— 引擎下次保存就把整个文件翻成 UTF-16。对中文用户这不是边角情况，是常态。
 *
 * 而 Node 按 utf-8 读 UTF-16 的结果是 `��{\0"\0F\0...`，`JSON.parse` 当场抛
 * `Unexpected token '�'`。这个异常是真实事故：工程导入后 UnrealAgentLink 装不上，
 * 用户只看到一句自己看不懂的报错，AI 从此看不见引擎里的任何东西。
 *
 * ## 反过来写回去用 UTF-8 是安全的
 *
 * `FFileHelper::BufferToString` 在没有 BOM 时按 UTF-8 解（`FileHelper.cpp:178`），
 * 9 个引擎（5.0–5.8）实测一致。所以盒子改完 `.uproject` 用不带 BOM 的 UTF-8 写回去，
 * 引擎读得回来，顺带还把文件的编码拉回了对 git diff 友好的那一种 —— 不需要为了写回
 * 再把 UTF-16 还原回去。
 */

/**
 * 按 BOM 解码引擎写的文本。没有 BOM 就按 UTF-8 —— 和引擎自己的判据一致。
 *
 * 注意 BOM 一定要剥掉再交给 `JSON.parse`：U+FEFF 不是合法的 JSON 起始字符。
 */
export function decodeUeText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // UTF-16BE：Node 只认 LE，先把每两个字节对调。长度是奇数说明文件被截断了，
    // 尾巴上那个半截字符直接丢掉，别让 swap16() 抛出来盖掉真正的错。
    const body = buffer.subarray(2)
    const swapped = Buffer.from(body.subarray(0, body.length - (body.length % 2)))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  return buffer.toString('utf8')
}

/** 读引擎写的文本文件，编码交给 {@link decodeUeText} 判断 */
export async function readUeTextFile(filePath: string): Promise<string> {
  return decodeUeText(await fs.promises.readFile(filePath))
}

/** 读引擎写的 JSON（`.uproject` / `.uplugin` / 启动器清单） */
export async function readUeJsonFile<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readUeTextFile(filePath)) as T
}
