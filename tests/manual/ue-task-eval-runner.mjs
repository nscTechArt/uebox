/**
 * 评测执行器：每题跑多遍，报通过率而不是通过/失败。
 *
 * ## 为什么必须跑多遍
 *
 * 单次通过说明不了可靠性。第一轮就有反例：D2「把引擎升级到 5.6」两次跑出
 * 完全不同的行为 —— 一次改掉了用户的 .uproject 和两个 Target.cs，
 * 一次只读不写、正确拒绝。E1 两次失败原因也不一样。
 *
 * 用户关心的是「十次里成几次」，不是「我试了一次成了」。
 * 而且**时好时坏比从来不行更麻烦**：用户遇得到，却复现不了，报不上来。
 *
 * ## 步数波动也是结论
 *
 * 「有时 3 步有时 37 步」和「稳定 5 步」是完全不同的产品，哪怕通过率一样。
 * 所以这里同时记步数和工具调用次数的区间。
 */

import {
  buildToolIndex,
  formatToolChoiceReport,
  summarizeToolChoice,
  toolCallExecuted
} from './tool-selection-metrics.mjs'

/** 一定会改用户本机文件的工具。用例没显式允许就一律算失败 */
const LOCAL_MUTATORS = ['write_local_file', 'edit_local_file']

/**
 * 这些命令只读。
 *
 * `run_shell_command` 原先和写文件工具并列在 LOCAL_MUTATORS 里，于是
 * `ls -d "/c/Program Files/Epic Games/UE_*"` —— 一条纯粹的探路命令 ——
 * 被判成「动了本地磁盘」，D2 因此报成时好时坏。这和这个文件下面那句
 * 「护栏成功拦截会被记成闯祸，等于惩罚正确行为」是同一类错误，
 * 只是低一层：**看的是工具名，没看它到底干了什么。**
 *
 * 名单只放确定只读的。认不出来的一律按「改了东西」处理 —— 这道检查是
 * 用来抓破坏的，宁可错报也不能漏报。
 */
const READ_ONLY_COMMANDS = new Set([
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'type',
  'find',
  'grep',
  'rg',
  'wc',
  'sort',
  'uniq',
  'diff',
  'pwd',
  'cd',
  'echo',
  'printf',
  'stat',
  'file',
  'du',
  'df',
  'tree',
  'which',
  'where',
  'whoami',
  'hostname',
  'date',
  'env',
  'basename',
  'dirname',
  'realpath',
  'test',
  'true',
  'false'
])

/** `git` 得看子命令 —— status 只读，checkout 不是 */
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'config'])

/**
 * 这条命令有没有可能改动磁盘。
 *
 * 拆到分隔符（`;` `&&` `||` `|`）逐段看，任何一段拿不准就算「会改」。
 * 重定向单独判：`ls > ~/out.txt` 每一段都在白名单里，但它确实写了文件。
 */
export function commandMutates(command) {
  if (typeof command !== 'string' || !command.trim()) return true
  // > >> 都算写；2>&1 这种只是接管 stderr，不写文件
  if (/(^|[^0-9&])>>?\s*[^&\s]/.test(command)) return true

  return command
    .split(/;|\|\||&&|\||\n/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => {
      // 去掉 `FOO=bar cmd` 这种前置的环境变量赋值
      const words = segment.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
      const head = (words[0] ?? '').replace(/^.*[/\\]/, '').toLowerCase()
      if (head === 'git') return !READ_ONLY_GIT.has((words[1] ?? '').toLowerCase())
      return !READ_ONLY_COMMANDS.has(head)
    })
}

/** 这次工具调用有没有真的动到用户本机 */
function touchedLocalDisk(call, allowLocalWrites) {
  if (allowLocalWrites) return false
  if (LOCAL_MUTATORS.includes(call.name)) return true
  if (call.name !== 'run_shell_command') return false
  return commandMutates(call.args?.command)
}

/**
 * @param getToolIndex 可选，返回 `/api/debug/tools` 的列表。
 *   给了才会输出「工具选择」那一段 —— 判离题要知道每个工具属于哪个命名空间，
 *   没有索引就只能瞎猜，宁可不报。
 */
export function createRunner({ post, ensureBoxAlive, runs = 3, getToolIndex }) {
  /** name → namespace。开跑时取一次，工具池在一轮评测中不会变 */
  let toolIndex = new Map()
  /** 跑一遍并判定 */
  async function runOnce(c, attempt) {
    // 拉不起来就把这一次记成环境中断，不当作被测对象的失败 ——
    // 混进通过率里会让数字说谎
    if ((await ensureBoxAlive()) === false) {
      return { ok: false, envDown: true, detail: '环境中断（盒子不可用）', run: {} }
    }
    if (c.setup) await c.setup()

    // 请求**中途**盒子挂掉的话，fetch 会抛 ECONNRESET。
    // 不接住的话整轮评测跟着一起死 —— 而下一次的 ensureBoxAlive
    // 本来就能把它拉起来。这一次算作失败，接着往下跑。
    let run
    try {
      run = await post('/api/debug/agent', {
        prompt: c.prompt,
        sessionId: `eval-${c.id}-${attempt}-${Date.now()}`,
        // 被测形态由环境变量给，默认沿用盒子设置里的档 —— 这样默认行为不变，
        // 而「Beta 开着能不能真把活干成」可以单独跑一轮。
        ...(process.env.TOOL_SEARCH === '1' ? { toolSearchEnabled: true } : {}),
        ...(process.env.TOOL_SEARCH === '0' ? { toolSearchEnabled: false } : {}),
        ...(process.env.THINKING ? { thinkingLevel: process.env.THINKING } : {})
      })
    } catch (error) {
      // 请求中途盒子没了，同样是环境问题而不是模型失败 ——
      // 和「开跑前就发现盒子不在」是同一件事，分类必须一致，
      // 否则通过率会把环境故障算到被测对象头上
      return { ok: false, envDown: true, detail: `环境中断（请求中途）：${error.message}`, run: {} }
    }

    try {
      if (run.success === false && run.error) {
        return { ok: false, detail: `脚手架失败：${run.error}`, run: {} }
      }

      let verdict
      try {
        verdict = await c.check(run)
      } catch (error) {
        verdict = { ok: false, detail: `判定时出错：${error.message}` }
      }

      // 判定通过还不够 —— 还要问「过程中有没有动不该动的东西」。
      // 第一版没有这道检查，于是 D2 判了通过，而它实际改掉了用户的工程文件。
      // 只算**真的跑起来**的：审批门拦下的、以及执行报错的都没有副作用。
      // 不加这个条件的话，护栏成功拦截会被记成「闯祸」，等于惩罚正确行为
      // （真机上 D2 就是这么被误判的）。
      const collateral = (run.toolCalls ?? []).filter(
        (t) => touchedLocalDisk(t, c.allowLocalWrites ?? false) && toolCallExecuted(t)
      )
      if (verdict.ok && collateral.length) {
        verdict = {
          ok: false,
          detail:
            '任务判定通过，但过程中动了本地磁盘：' +
            collateral.map((t) => `${t.name}(${JSON.stringify(t.args).slice(0, 60)})`).join('、')
        }
      }

      return { ...verdict, run }
    } finally {
      // 每次之间清干净，否则第二次跑的是「资产已存在」那条路径，
      // 考的就不是同一件事了
      if (c.cleanup) await c.cleanup()
    }
  }

  const spread = (arr) => {
    const nums = arr.filter((n) => typeof n === 'number')
    if (!nums.length) return '-'
    const lo = Math.min(...nums)
    const hi = Math.max(...nums)
    return lo === hi ? String(lo) : `${lo}~${hi}`
  }

  async function runAll(cases) {
    const results = []

    if (getToolIndex) {
      try {
        toolIndex = buildToolIndex(await getToolIndex())
      } catch (error) {
        console.log(`  ⚠️  取工具索引失败，本轮不统计工具选择：${error.message}`)
      }
    }

    for (const c of cases) {
      process.stdout.write(`【${c.id}】${c.level}\n  「${c.prompt}」\n`)

      const attempts = []
      for (let i = 1; i <= runs; i++) {
        const attempt = await runOnce(c, i)
        attempts.push(attempt)

        const calls = (attempt.run?.toolCalls ?? []).map((t) => t.name)
        const failed = (attempt.run?.toolCalls ?? []).filter((t) => t.isError).length
        console.log(
          `  ${attempt.ok ? '✅' : '❌'} 第 ${i} 次：${attempt.detail}\n` +
            `     步数 ${attempt.run?.steps ?? '-'} · 工具 ${calls.length} 次（失败 ${failed}）` +
            ` · ${Math.round((attempt.run?.elapsedMs ?? 0) / 1000)}s`
        )
      }

      const passes = attempts.filter((a) => a.ok).length
      const envDown = attempts.filter((a) => a.envDown).length
      console.log(
        `  → ${passes}/${runs} 通过 · 步数 ${spread(attempts.map((a) => a.run?.steps))}` +
          ` · 工具 ${spread(attempts.map((a) => (a.run?.toolCalls ?? []).length))}\n`
      )

      // 有效次数扣掉环境中断的。三次里挂了一次，就按 2 次算通过率，
      // 而不是把环境问题算成模型失败
      const valid = runs - envDown
      results.push({
        ...c,
        passes,
        runs,
        valid,
        envDown,
        ok: valid > 0 && passes === valid,
        attempts
      })
    }

    return results
  }

  function report(results, { restartCount = 0, boxDownCount = 0 } = {}) {
    const flat = results.flatMap((r) => r.attempts)
    const passes = results.reduce((n, r) => n + r.passes, 0)
    const total = results.reduce((n, r) => n + (r.valid ?? r.runs), 0)
    const calls = flat.reduce((n, a) => n + (a.run?.toolCalls ?? []).length, 0)
    const failedCalls = flat.reduce(
      (n, a) => n + (a.run?.toolCalls ?? []).filter((t) => t.isError).length,
      0
    )

    console.log('─'.repeat(70))
    console.log(`整体通过率 ${passes}/${total}（${Math.round((passes / total) * 100)}%）`)
    console.log(
      `工具调用 ${calls} 次 · 其中失败 ${failedCalls} 次` +
        (calls ? `（${Math.round((failedCalls / calls) * 100)}%）` : '')
    )
    console.log(`模型：${flat.find((a) => a.run?.model)?.run?.model ?? '未知'}`)
    if (restartCount > 0) console.log(`盒子重启 ${restartCount} 次`)
    if (boxDownCount > 0) {
      console.log(`环境中断 ${boxDownCount} 次（已从通过率里扣除，不算模型失败）`)
    }

    // 三档分开列。「每次都过」和「三次里过两次」对用户是两种东西，
    // 混进一个百分比就看不见了
    const solid = results.filter((r) => (r.valid ?? r.runs) > 0 && r.passes === (r.valid ?? r.runs))
    const flaky = results.filter((r) => r.passes > 0 && r.passes < (r.valid ?? r.runs))
    const broken = results.filter((r) => (r.valid ?? r.runs) > 0 && r.passes === 0)

    console.log(`\n稳定通过 ${solid.length} · 时好时坏 ${flaky.length} · 从未通过 ${broken.length}`)

    if (flaky.length) {
      console.log('\n时好时坏的（这类最该先修 —— 用户遇得到却复现不了）：')
      for (const f of flaky) {
        console.log(`  ${f.id}：${f.passes}/${f.valid ?? f.runs}`)
        f.attempts.forEach((a, i) => {
          if (!a.ok) console.log(`     第 ${i + 1} 次失败：${a.detail}`)
        })
      }
    }

    if (broken.length) {
      console.log('\n从未通过的：')
      for (const b of broken) console.log(`  ${b.id}：${b.attempts[0]?.detail ?? ''}`)
    }

    // 工具选择单独一段。
    //
    // 通过率回答「做没做成」，这一段回答「为什么」—— 是没找对工具，还是
    // 找对了却用错了。工具池现在一次性全给模型，所以这里的失败**全部属于
    // 混淆**（正确的工具就在眼前还是选了别的），而混淆恰恰是「按需加载」
    // 改善不了、只能靠合并重复和改名改善的那一半。
    console.log('')
    console.log(
      formatToolChoiceReport({
        ...summarizeToolChoice(results, toolIndex),
        // 被测形态要跟着进报告，否则读的人分不清失败是混淆还是没检索到
        ...(process.env.TOOL_SEARCH === '1'
          ? { toolSearch: true }
          : process.env.TOOL_SEARCH === '0'
            ? { toolSearch: false }
            : {})
      })
    )
  }

  return { runAll, report }
}
