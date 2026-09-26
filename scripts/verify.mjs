#!/usr/bin/env node
/**
 * 一键验收门禁 / One-command acceptance gate.
 *
 * 这是贡献者和 AI Agent **唯一**需要记住的命令：
 *
 *   pnpm verify
 *
 * ## 这个文件是门禁的唯一真相
 *
 * CI（.github/workflows/quality.yml）不再自己列检查项，它只跑 `pnpm verify --ci`。
 * 所以「本地绿了 = CI 会绿」是**结构上保证**的，而不是靠两边手工同步。
 * 加一道门禁只需要往下面的 STEPS 里加一项，本地和 CI 同时生效。
 *
 * ## 关于 better-sqlite3 的 ABI
 *
 * 以前这里要在 Node 与 Electron 两套 ABI 之间来回重编译，跑完还得切回去，
 * 而且**应用开着就切不动**（.node 被占用）。现在两套产物各缓存一份，测试走
 * 缓存里的 Node 版、`pnpm dev` 走 node_modules 里的 Electron 版，互不相干 ——
 * 所以这个脚本不再需要任何 ABI 切换或收尾复原，开着应用也能跑完整门禁。
 * 细节见 scripts/better-sqlite3-abi.mjs。
 *
 * ## 参数
 *   --fast         跳过重量步骤（迭代中自查；提交前仍需跑完整 verify）
 *   --changed      只查你改的东西（迭代中途的快档，见 CHANGED 的说明）
 *   --with-build   额外跑打包与离线启动门禁（改了主进程 / 构建配置 / 依赖时建议加上）
 *   --ci           仓库 CI 档案：额外跑 audit:prod、打包与离线启动门禁；
 *                  插件包检查不跑，并明确报告为 NOT RUN
 */
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const FAST = argv.includes('--fast')
const CI = argv.includes('--ci')
/**
 * 迭代中途用的快档：只查**你改的东西**。
 *
 * 动机是实测数据：完整门禁里全量 lint 棘轮 49 秒、两侧类型检查 45 秒、
 * 全量单测 126 秒 —— 而那 126 秒里真正执行测试只有 43 秒，其余是 386 个
 * 测试文件各建一遍环境。改两个模块时，相关的往往只有几个文件。
 *
 * 它**不是**完整门禁的替代品，只是把「等两分半」变成「等半分钟」：
 *   - 全量 lint 棘轮跳过（新代码由 lint:changed 零容忍把关）；
 *   - 类型检查只查改动涉及的那一侧；
 *   - 单测只跑与改动相关的那些。
 *
 * 交活前必须再跑一次完整的 `pnpm verify`。
 */
const CHANGED = argv.includes('--changed')
const WITH_BUILD = argv.includes('--with-build') || CI
const isWindows = process.platform === 'win32'

/**
 * 门禁的完整定义。本地与 CI 共用这一份。
 *
 * ciOnly: true 的步骤只在 `--ci` 下跑 —— 它们要么需要联网（audit），
 * 要么太慢不适合每次本地自查（build，本地可用 --with-build 手动触发）。
 * localOnly（写不跑的理由）的步骤反过来，只在本地跑；`--ci` 下把它列成 NOT RUN，
 * 让 CI 的绿灯不被误读成「这一项也查过了」。
 *
 * ## 插件分发包检查按改动范围决定
 *
 * 日常门禁走 `verify:plugin`：先看这次改动要不要查包，再读
 * `VERIFY_PLUGIN_ENGINE`（或 `verify:plugin --engine`）。无关的 UI / 文档改动
 * 不会打开 zip，也不会去发现本机引擎。
 *
 * 严格的那一档仍是 `plugin:check:all`，挂在出正式安装包的脚本上
 * （`build:win` / `build:mac` / `build:linux`），要求**每个**版本都新鲜。
 * 普通打包 / 离线启动不因此要求全套发版包。
 */
const STEPS = [
  {
    title: '密钥扫描 / secret scan',
    script: 'security:secrets',
    hint: [
      '仓库里出现了疑似密钥/凭据的字符串。',
      '把它移到 .env（已被 .gitignore 忽略），代码里读 process.env。',
      '示例文件见 .env.example。'
    ]
  },
  {
    title: 'overrides 两表同步 / overrides sync',
    script: 'verify:overrides',
    hint: [
      'package.json 里有两份依赖强制替换表，服务两拨读者：',
      '  · pnpm.overrides —— 决定实际装什么；',
      '  · overrides      —— npm 与 GitHub 的依赖图 / 安全扫描读它。',
      '',
      '手工维护的重复品必然会漂。漂了的后果是安全修复只落实一半：',
      '装的是安全版本，但 GitHub 读到的是旧版本，安全页照旧挂红（或者反过来，',
      '以为修好了其实没装上）。改一份就必须改另一份。'
    ]
  },
  {
    title: '官方端点棘轮 / official endpoints',
    script: 'verify:official-endpoints',
    hint: [
      '社区版不该新增对官方服务端的调用（全部 /api/ 路径、遥测上报、官方域名字面量）。',
      '模型请走 resolveLanguageModel（主进程）或 window.api.ai（渲染层）；',
      '注意：棘轮只准变小。想让基线变大是不允许的，请开 Issue 说明理由。'
    ]
  },
  {
    title: 'localStorage 用途 / localStorage usage',
    script: 'verify:local-storage',
    hint: [
      '社区版的承诺是「数据在用户自己手里」，前提是：用户创作的东西，',
      '唯一真相源必须是磁盘上的文件，数据库只是能删掉重建的索引。',
      'localStorage 不在保管库目录里 —— 拷不走、备份不到、换台机器就没了，',
      '而且只有几 MB，写满会把用户的操作崩在半路（蓝图库/材质库踩过）。',
      '',
      '每个 key 都要在 scripts/local-storage.baseline.json 里登记类别与理由：',
      '  · ui      界面偏好、一次性标记、可重建的缓存 —— 登记即可；',
      '  · content 用户创作的内容 —— 不许新增，落到保管库里的文件；',
      '  · secret  凭据 —— 不许新增，走主进程安全存储。',
      '',
      'content / secret 是棘轮，只准变少。迁走一批之后跑：',
      '  node scripts/check-local-storage.mjs --update'
    ]
  },
  {
    title: '颜色体系 / color system',
    script: 'verify:colors',
    hint: [
      '一套色彩体系不是调好一次就完事，它是每天都在被稀释的东西 ——',
      '某个组件需要「稍微亮一点的蓝」，顺手写个十六进制。一千次之后就散架了。',
      '',
      '这一步守两条：',
      '  · 引用的 --color-* 必须有定义。引用不存在的变量，CSS 不报错，',
      '    它会静静地让整条声明失效、文字掉回继承色 —— review 里看不出来。',
      '  · 裸写的颜色逐文件棘轮，只准变少。存量允许存在，新增不行。',
      '',
      '新代码要用颜色，先想清楚它是什么角色，再用对应语义变量（文字/表面/描边/强调/状态）。',
      '找不到合适的角色说明缺一个角色 —— 去 scripts/gen-palette.mjs 加，别就地写死。',
      '清完一批之后收紧基线：pnpm verify:colors --update'
    ]
  },
  {
    title: '全量 lint 棘轮 / lint baseline ratchet',
    script: 'lint',
    // 全仓跑一遍 ESLint 要 49 秒，守的是「存量不变多」——
    // 新代码由下一步的 lint:changed 零容忍把关，迭代中途跳过它不漏新问题
    changedSkip: true,
    hint: [
      '这一步对全仓跑 ESLint，和 scripts/lint.baseline.json 里的存量基线逐文件比对。',
      '存量问题不用你修，但不能变多。',
      '看具体问题：npx eslint <文件路径>；自动修：npx eslint --fix <文件路径>',
      '如果提示「存量问题变少了」，跑 pnpm lint:baseline:update 收紧基线并一起提交。'
    ]
  },
  {
    title: '改动行 lint（新代码零容忍）/ lint changed lines',
    script: 'lint:changed',
    hint: [
      '只有你这次改动的行会被检查，报出来的都是新写的代码。',
      '上面的输出里已经给了具体修复命令。'
    ]
  },
  {
    title: '引擎文件读取 / UE file reads',
    script: 'verify:ue-file-reads',
    hint: [
      '引擎保存 .uproject / .uplugin 用 AutoDetect 编码：内容里有一个非 ASCII 字符',
      '（中文工程名、中文描述）就整份存成 UTF-16LE —— 中文用户那边这是常态。',
      '按 utf-8 硬读会得到乱码，JSON.parse 抛 Unexpected token，',
      '用户看到的是「插件装不上、AI 看不见引擎」，而报错信息他一个字也看不懂。',
      '',
      '改用 src/main/utils/ueTextFile.ts：readUeTextFile / readUeJsonFile / decodeUeText。',
      '写回去仍然用 UTF-8（不带 BOM），引擎没有 BOM 时按 UTF-8 解，5.0–5.8 一致。'
    ]
  },
  {
    title: '双语文档同步 / bilingual docs',
    script: 'docs:check',
    hint: [
      '成对的中英文档必须一起改，否则另一半贡献者会照着过期规范干活。',
      '成对清单见 scripts/check-docs-sync.mjs 顶部的 PAIRS。'
    ]
  },
  {
    title: 'Skill 规范 / skill standard',
    script: 'verify:skills',
    hint: [
      'skill 坏掉不会报错 —— 它只会悄悄不触发，或者被 Claude 只读到一半，',
      '在开发机上完全看不出来，用户那边表现为「这个功能时灵时不灵」。',
      '',
      '最常见的三种：',
      '  · description 没写「什么时候不要用」，于是和邻近 skill 抢触发；',
      '  · references/ 里加了文件但 SKILL.md 没提它 —— 那个文件永远不会被读到；',
      '  · reference 文件超过 100 行又没有目录 —— Claude 半读时看不到后半截。',
      '',
      '规则全文：resources/skills/SKILL_STANDARD.md',
      '看每个 skill 的体检数据：node scripts/check-skills.mjs --list'
    ]
  },
  {
    title: '插件分发包（按改动）/ plugin package (scoped)',
    script: 'verify:plugin',
    localOnly: 'CI runner 上没有 Unreal 和插件包；插件原生构建/运行时同样未验证',
    hint: [
      '怎么修见上面这一步自己的输出；完整规则见 docs/contributing/packaging.zh-CN.md 的「日常门禁」。'
    ]
  },
  {
    title: '类型检查 / typecheck',
    script: 'typecheck',
    changedTitle: '类型检查（按改动挑）/ typecheck (changed)',
    changedScript: 'typecheck:changed',
    hint: [
      '主进程用 tsconfig.node.json，渲染进程用 tsconfig.web.json，两边都要过。',
      '常见原因：改了 src/preload/index.ts 但忘了同步 src/preload/index.d.ts。'
    ]
  },
  {
    title: '单元测试 / tests',
    fastTitle: '单元测试（快速）/ tests (fast)',
    script: 'test:run',
    fastScript: 'test:run:fast',
    changedTitle: '相关单测 / related tests',
    changedScript: 'test:related',
    hint: [
      '单独调试：npx vitest run <测试文件路径>',
      '新增功能必须有对应单测。测试放 tests/ 或与源码同目录的 *.test.ts 均可。',
      '不要用跳过/删除测试的方式让门禁变绿。',
      '',
      '如果报 NODE_MODULE_VERSION / better_sqlite3.node，说明原生产物缓存没建好：',
      '  node scripts/better-sqlite3-abi.mjs status   看缓存状态',
      '  node scripts/better-sqlite3-abi.mjs ensure node   补上 Node 版（不碰 node_modules）'
    ],
    fastHint: [
      '单独调试：npx vitest run <测试文件路径>',
      '如果报 NODE_MODULE_VERSION，跑 node scripts/better-sqlite3-abi.mjs ensure node'
    ]
  },
  {
    title: '依赖漏洞审计 / dependency audit',
    script: 'audit:prod',
    ciOnly: true,
    hint: [
      '生产依赖里有 high 及以上的已知漏洞。',
      '先试 pnpm update <包名>；升不动就在 PR 里说明影响面。',
      '本地想手动跑一次：pnpm audit:prod（需要联网）'
    ]
  },
  {
    /**
     * 用 build:unpack 而不是 build：它 = build + electron-builder --dir +
     * verify:packaged-deps，产出 dist/win-unpacked/。下一步的离线启动门禁要拿这份
     * 打包产物去跑，光有 electron-vite 的 out/ 不够。
     * 顺带把原本只能手动跑的「打包依赖闭包」检查也纳入了门禁。
     */
    title: '生产构建 + 打包 / build & package',
    script: 'build:unpack',
    ciOnly: true,
    withBuild: true,
    hint: [
      '构建失败通常来自主进程代码或原生依赖，先看第一条报错的文件。',
      '若卡在 verify:packaged-deps，说明 electron-builder 漏采了传递依赖 ——',
      '把缺的包在 package.json 里显式声明为直接依赖。'
    ]
  },
  {
    /** 在打包产物中逐页验证默认启动和本地功能不会请求应用官方服务器。 */
    title: '离线启动门禁 / offline boot',
    script: 'verify:offline-boot',
    ciOnly: true,
    withBuild: true,
    hint: [
      '社区版承诺冷启动完全离线可用。这一步启动打包产物，逐个功能页走一遍，',
      '断言首屏不白屏、不停在账号页、且没有指向官方服务端的请求。',
      '',
      '报出请求时请删除平台请求，使用用户明确配置的服务地址。',
      '',
      '注意它的覆盖边界：CDP 只看得见**渲染层**。主进程的 fetch / axios /',
      'net.request（例如自动更新）不进 CDP，这一步看不到，靠',
      'verify:official-endpoints 的静态扫描兜。'
    ]
  }
]

/** 按当前模式挑出要跑的步骤 */
function resolveSteps() {
  return STEPS.filter((step) => !step.ciOnly || CI || (step.withBuild && WITH_BUILD))
    .filter((step) => !(CHANGED && step.changedSkip))
    .filter((step) => !(CI && step.localOnly))
    .map((step) => ({
      title: (CHANGED && step.changedTitle) || (FAST && step.fastTitle) || step.title,
      script: (CHANGED && step.changedScript) || (FAST && step.fastScript) || step.script,
      hint: (FAST && step.fastHint) || step.hint
    }))
}

function run(args) {
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
    shell: isWindows
  })
  if (result.error) {
    console.error(result.error)
    return 1
  }
  return typeof result.status === 'number' ? result.status : 1
}

function main() {
  const steps = resolveSteps()
  const mode = [CI && 'ci', FAST && 'fast', CHANGED && 'changed'].filter(Boolean).join(' ')
  console.log(`\n虚幻盒子 · 验收门禁（共 ${steps.length} 步）${mode ? ` [${mode}]` : ''}\n`)
  if (CI) {
    for (const step of STEPS.filter((s) => s.localOnly)) {
      console.log(`  – NOT RUN：${step.title}（${step.localOnly}）`)
    }
    console.log('')
  }

  let failedAt = 0

  for (const [index, step] of steps.entries()) {
    const no = index + 1
    console.log(`──────── [${no}/${steps.length}] ${step.title} ────────`)
    const code = run(['-s', 'run', step.script])
    if (code !== 0) {
      failedAt = no
      console.error(`\n✖ 门禁卡在第 ${no} 步：${step.title}\n`)
      for (const line of step.hint) console.error(`  · ${line}`)
      console.error('\n修完之后重新跑：pnpm verify')
      break
    }
    console.log(`✓ [${no}/${steps.length}] ${step.title}\n`)
  }

  if (failedAt > 0) {
    process.exit(1)
  }

  if (CHANGED) {
    console.log('\n✅ 改动相关的检查全绿。')
    console.log('   这是迭代中途的快照 —— 交活前请再跑一次完整的 `pnpm verify`。')
    return
  }

  console.log('\n✅ 门禁全绿，可以提交了。')
  if (!CI) {
    console.log('   提交信息用 Conventional Commits + 中文描述，例如：feat: 支持自定义标签颜色')
    console.log('   验收清单：docs/contributing/definition-of-done.zh-CN.md')
    if (!WITH_BUILD) {
      console.log(
        '   注：CI 会额外跑 pnpm audit:prod、打包与离线启动门禁（本地：pnpm verify --with-build）。'
      )
    }
  }
}

main()
