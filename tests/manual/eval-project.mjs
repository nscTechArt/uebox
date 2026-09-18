/**
 * 一次性测试工程 —— 关于它的三个判断，全在这里，全是纯函数。
 *
 * | 要回答的问题 | 用哪个 |
 * |---|---|
 * | 这个目录能不能删（重建副本前） | `planRestore` |
 * | 引擎连着的是不是它 | `sameProject` / `normalizeProjectPath` |
 * | 它和起点比变了没有 | `fingerprintOf` |
 *
 * 三件事看着不相干，但主体是同一个：**那份可以整个丢弃的测试工程副本**。
 * 拆成三个文件只会多出两个实体和一堆 import，不会让任何一处更清楚。
 *
 * 真机接线在 `eval-ue-project.mjs`；这里一行 I/O 都没有，
 * 好让「模板和副本填成同一路径」这类反例能在不碰真实磁盘的情况下被测住。
 *
 * ── 以下是每一条的来由 ──────────────────────────────────────────────
 *
 * ## 为什么删除判定必须是纯函数
 *
 * 这里唯一的操作是 `rm -rf`，而它作用在**环境变量给的路径**上。写错一个变量，
 * 删掉的就是模板本身、或者用户真实的 UE 工程 —— 那些工程大多不在版本控制里，
 * 删了没有任何东西能还原。
 *
 * 评审用模拟文件系统复现过：把模板和副本填成同一个路径，脚本会**先删模板、
 * 再复制失败**。所以判定逻辑必须能在不碰真实磁盘的情况下被反例测住。
 *
 * ## 四道闸，缺一不可
 *
 * 1. **两个路径都要有**，且解析成绝对路径后**不相等**；
 * 2. **不能互相包含** —— `D:\eval` 和 `D:\eval\Run` 这种，删副本会连模板一起端；
 * 3. **模板必须存在**，否则删完副本就没得复制了；
 * 4. **副本要么不存在，要么带着我们自己写下的标记文件**。
 *    第 4 条是核心：它把「这是脚本造出来的一次性目录」变成可核实的事实，
 *    而不是靠操作者填对了变量。指向一个已有的真实工程时，那里没有标记，直接拒。
 *
 * 另外还要求副本路径至少有两层（`D:\Run` 可以，`D:\` 不行），
 * 挡住变量为空时拼出盘符根目录的情况。
 */
import { sep } from 'node:path'

/** 标记文件名。它的存在 = 这个目录是脚本造的，可以整个丢弃 */
export const EVAL_COPY_MARKER = '.uebox-eval-disposable'

/**
 * 比较用的形式。**Windows 上必须折叠大小写。**
 *
 * `D:\eval\Template` 和 `d:\EVAL\template` 在 Windows 上是同一个目录，
 * 按区分大小写的字符串比会全部放行 —— 于是「模板和副本同路径」「互相包含」
 * 这几条闸都能靠改一下大小写绕过去，而底下挂着的是 `rm -rf`。
 */
function forCompare(p, isWindows) {
  return isWindows ? p.toLowerCase() : p
}

/** a 是不是 b 本身或 b 的子目录（按路径分段比，避免 `D:\evalX` 被当成 `D:\eval` 的子目录） */
function contains(a, b) {
  if (a === b) return true
  return b.startsWith(a.endsWith(sep) ? a : a + sep)
}

/**
 * 判断能不能执行「丢弃副本 + 从模板重建」。
 *
 * 文件系统的三个问题由调用方注入，好让测试用模拟实现跑：
 *   - `resolve(p)`      解析成绝对路径
 *   - `exists(p)`       目录在不在
 *   - `hasMarker(p)`    目录里有没有标记文件
 */
export function planRestore({
  template,
  project,
  resolve,
  exists,
  hasMarker,
  isWindows = process.platform === 'win32'
}) {
  if (!template || !project) {
    return { ok: false, error: '需要同时设置 SKILL_EVAL_UE_TEMPLATE 和 SKILL_EVAL_UE_PROJECT' }
  }

  // 原样的解析结果用来做真正的文件操作；比较一律用折叠过大小写的那份
  const t = resolve(template)
  const p = resolve(project)
  const tc = forCompare(t, isWindows)
  const pc = forCompare(p, isWindows)

  // 盘符根目录、或者只有一层的路径：变量拼空/拼错时最容易落到这里。
  //
  // 这条结构性检查要排在下面几条关系检查**之前** —— 路径落到 `D:\` 时
  // 「模板在副本里面」也会成立，先报那条会把原因指错方向。
  const segments = p.split(sep).filter(Boolean)
  if (segments.length < 2) {
    return { ok: false, error: `副本路径太浅（${p}），拒绝在这种路径上执行删除` }
  }

  if (tc === pc) {
    return { ok: false, error: `模板和副本是同一个路径（${p}）—— 这会先删掉模板` }
  }
  if (contains(tc, pc)) {
    return { ok: false, error: `副本在模板里面（${p} ⊂ ${t}）—— 重建时会把模板一起端掉` }
  }
  if (contains(pc, tc)) {
    return { ok: false, error: `模板在副本里面（${t} ⊂ ${p}）—— 删副本会连模板一起删` }
  }

  if (!exists(t)) {
    return { ok: false, error: `模板不存在：${t}` }
  }

  // 核心那一条：已经存在、又没有标记 —— 说明它不是脚本造的，可能是真实工程
  if (exists(p) && !hasMarker(p)) {
    return {
      ok: false,
      error:
        `副本目录已存在但没有标记文件 ${EVAL_COPY_MARKER}：${p}\n` +
        '  它不是这个脚本造出来的，不能当一次性目录删掉。\n' +
        '  确认这个路径可以整个丢弃之后，手动删掉它再跑一次。'
    }
  }

  return { ok: true, template: t, project: p, willDelete: exists(p) }
}

/**
 * UE 报回来的工程路径 → 可比较的形式。
 *
 * 引擎那边可能给 `.uproject` 文件、也可能给工程目录；斜杠方向不定；
 * Windows 上大小写不敏感。直接 `===` 比必然误判 —— 而这条判断底下挂着
 * 「要不要允许写操作跑在这个工程上」，误判成"是副本"就等于把守卫拆了。
 */
export function normalizeProjectPath(raw, { resolve, dirname, isWindows = true } = {}) {
  if (!raw || typeof raw !== 'string') return null
  let s = raw.trim().replace(/^["']|["']$/g, '')
  if (!s) return null
  s = s.split(/[\\/]+/).join(sep)
  // 给到 .uproject 文件时取它所在目录：工程的身份是目录，不是那个文件
  if (/\.uproject$/i.test(s)) s = dirname(s)
  s = resolve(s).replace(new RegExp(`\\${sep}+$`), '')
  return isWindows ? s.toLowerCase() : s
}

/** 引擎连着的工程，是不是我们声明的那个一次性副本 */
export function sameProject(reported, expected, opts) {
  const a = normalizeProjectPath(reported, opts)
  const b = normalizeProjectPath(expected, opts)
  if (!a || !b) return false
  return a === b
}

/**
 * 「下一条写操作从相同起点开始」怎么算数。
 *
 * 靠"我刚跑过 --restore"这种记忆是不算数的 —— 中间可能开过编辑器、
 * 手动改过东西、上一条用例写了资产。所以要拿**内容指纹**说话：
 * 相对路径 + 内容哈希，排序后拼起来。
 *
 * 不含 mtime：拷贝会改时间戳，那样每次都对不上，等于没有基线。
 * 不含 `Saved/` `Intermediate/` `DerivedDataCache/` `Binaries/`：
 * 打开一次编辑器就会变，它们不属于"起点"。
 */
export const FINGERPRINT_IGNORED = Object.freeze([
  'Saved',
  'Intermediate',
  'DerivedDataCache',
  'Binaries',
  '.vs'
])

/**
 * 单个文件级的忽略项。
 *
 * `.uebox-eval-disposable` 是脚手架自己写的标记，里面带创建时间 —— 每次 restore
 * 都不一样。真机上就是它（连同 `DefaultEngine.ini` 里的随机 SecurityToken）
 * 让「两轮起点是否一致」判成了不一致，而它根本不是工程内容。
 */
export const FINGERPRINT_IGNORED_FILES = Object.freeze([EVAL_COPY_MARKER])

/** 纯逻辑部分：给一组 {relPath, sha256} 算出稳定指纹 */
export function fingerprintOf(entries) {
  return entries
    .filter((e) => {
      const parts = e.relPath.split(/[\\/]/)
      if (FINGERPRINT_IGNORED.includes(parts[0])) return false
      return !FINGERPRINT_IGNORED_FILES.includes(parts[parts.length - 1])
    })
    .map((e) => `${e.relPath.split(/[\\/]/).join('/')}:${e.sha256}`)
    .sort()
    .join('\n')
}
