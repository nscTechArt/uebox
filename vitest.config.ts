import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],

  // 服务器配置
  server: {
    watch: {
      ignored: ['node_modules/**', 'dist/**', 'out/**', 'coverage/**']
    }
  },

  test: {
    // 测试环境
    environment: 'happy-dom',

    /**
     * 单测里不发真实网络请求。
     *
     * happy-dom 默认会真的去加载 `<link rel=stylesheet>` 和 `<script src>`：
     * 组件（如 BlueprintRenderer）插入的 `ueblueprint/...` 资源会被解析成
     * `http://localhost:3000/...`（happy-dom 的默认 origin），于是每次跑到就往
     * 本机 3000 端口发一次 HTTP。没有人监听 → ECONNREFUSED。
     *
     * 大多数时候它只是被吞成 fetch 的 NetworkError，但 `<script src>` 走的是
     * **同步**加载：happy-dom 会 spawn 一个 `node -e` 子进程去发请求，连接失败时
     * 子进程里的 'error' 事件没人接，直接 `throw er` —— 偶发把 vitest worker
     * 一起带走，`pnpm verify` 就卡在单元测试这一步。
     *
     * 这里从根上关掉资源加载：不发请求，也就没有可以炸的连接。
     * `handleDisabledFileLoadingAsSuccess` 让被跳过的加载照常派发 load 事件，
     * 组件的 onload 分支能正常走完，不会退化成加载失败的错误态。
     */
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true
        }
      }
    },

    // 全局测试设置
    globals: true,

    // 包含的测试文件
    include: [
      'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      // 独立子包（uebox CLI）。不写这一行的话它的测试根本不会被跑到，
      // 而门禁会全绿 —— 见 docs/CLI设计.md §8
      'packages/*/src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'
    ],

    // 排除的文件
    exclude: ['node_modules', 'dist', 'out', '.idea', '.git', '.cache'],

    // 覆盖率配置
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/',
        'dist/',
        'out/',
        'coverage/',
        '**/*.d.ts',
        '**/*.config.{js,ts}',
        '**/index.{js,ts}',
        'src/main/**', // Electron 主进程代码
        'src/preload/**', // Electron 预加载脚本
        'build/**',
        'resources/**'
      ],
      include: ['src/renderer/**'],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80
        }
      }
    },

    // 设置超时时间
    testTimeout: 10000,
    hookTimeout: 10000,

    /**
     * 并发用**进程**而不是线程。
     *
     * 原来是 `threads`，症状是：3822 条测试全绿，然后进程在收尾时段错误退出
     * （Windows 上 exit code 3221225477 = 0xC0000005，Git Bash 里显示
     * Segmentation fault）。测试没有失败，是**析构**炸的 —— 表现为「门禁随机
     * 变红，单独再跑一遍又是绿的」，多开几个 Agent 并行时尤其烦人。
     *
     * 根因是原生模块（better-sqlite3）在 worker 线程池里被反复加载/卸载：
     * 线程之间共享进程地址空间，原生模块的清理顺序没有保证。改成 forks 之后
     * 每个 worker 是独立进程，退出即回收，踩不到彼此。
     *
     * 实测（同一台机器、同一份代码，各跑若干次）：
     *   threads：3 次里崩 1 次，成功那两次 150s / 141s
     *   forks：  6 次全过，133~158s
     *
     * 代价是进程启动比线程贵一点，中位耗时基本持平（约 +3%）—— 用这点时间
     * 换掉一个随机变红的门禁，值。
     */
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },

    /**
     * `@electron-toolkit/utils` 必须走 Vite 的转换链，不能外部化。
     *
     * 它在 node_modules 里，Vitest 默认把这类依赖 externalize —— 于是它绕开转换
     * 直接以原生 ESM 去 require 真正的 `electron`（那是个 CJS 包），命名导入
     * 当场炸：`Named export 'BrowserWindow' not found`。
     *
     * 关键是**测试里的 `vi.mock('electron')` 拦不住它**：mock 只作用于走转换链的
     * 模块。所以任何 import 链上碰到 `src/main/services/agentBrowser/index.ts` 的
     * 测试文件（createAgent、appSettings 等）整个**收集不起来** —— 表现为
     * 「0 个测试失败，但文件红了」，很容易被当成环境问题放过去。
     */
    server: { deps: { inline: ['@electron-toolkit/utils'] } },

    // 监听模式设置
    watch: false,

    // 快照设置
    resolveSnapshotPath: (testPath, snapExtension) => {
      return testPath.replace(/\.test\.([tj]sx?)/, `.__snapshots__/test$1${snapExtension}`)
    },

    // 设置文件
    setupFiles: ['./tests/setup.ts'],

    // 默认门禁只输出终端摘要，详细报告由 test:reporter 显式生成。
    reporters: ['default']
  },

  // 解析配置
  resolve: {
    /**
     * 用数组形式而不是对象形式，是为了能写**精确匹配**。
     *
     * 对象形式的键是前缀匹配：写 `'better-sqlite3'` 会连
     * `better-sqlite3/lib/database.js` 一起改写，而那正是下面那个垫片自己要
     * require 的东西 —— 于是垫片把自己重写成自己，直接自我递归。
     */
    alias: [
      /**
       * 原生模块走测试专用入口，**不碰 node_modules 里那份**。
       *
       * better-sqlite3 的 Node 与 Electron ABI 不同（127 / 139）。以前是同一个
       * `.node` 文件来回重编译，于是「应用开着就跑不了测试」—— 那个文件被 Electron
       * 进程锁着，Windows 上连删都删不掉（EPERM）。
       *
       * 现在两份产物各存一份：`node_modules` 里那份永远是 Electron ABI 供
       * `pnpm dev` 用，测试通过这个垫片读缓存里的 Node ABI 副本。两边只读不抢，
       * 应用开着照样能跑测试。产物由 scripts/better-sqlite3-abi.mjs 维护。
       */
      {
        find: /^better-sqlite3$/,
        replacement: resolve(__dirname, 'tests/support/betterSqlite3.node-abi.cjs')
      },
      { find: '@renderer', replacement: resolve(__dirname, 'src/renderer/src') },
      { find: '@core', replacement: resolve(__dirname, 'src') },
      // 这两个放最后：'@' 是 '@renderer' 等的前缀，先匹配会把它们全吃掉
      { find: '@', replacement: resolve(__dirname, 'src/renderer/src') },
      { find: '~', replacement: resolve(__dirname, 'src/renderer/src') }
    ]
  },

  // 定义全局变量
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false
  }
})
