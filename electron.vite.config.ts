import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const coreRoot = dirname(fileURLToPath(import.meta.url))
const coreSourceRoot = resolve(coreRoot, 'src')

// ESM-only dependencies must be bundled into the CommonJS main process.
const ESM_ONLY_DEPS = Object.freeze([
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-telemetry',
  // MCP SDK 也是 "type": "module"。漏掉它的表现极其难查：打包产物**静默退出**，
  // 退出码 1，stdout / stderr 全空 —— 因为 ERR_REQUIRE_ESM 发生在日志初始化之前。
  // 已确认 dist/esm 下没有顶层 await，可以安全降级成 CJS。
  '@modelcontextprotocol/sdk'
]) as unknown as string[]

export default defineConfig({
  main: {
    // pi 全家是 ESM-only（"type": "module"）。externalizeDepsPlugin 默认把所有
    // dependencies 外置成运行时 require()，CJS 主进程 require 一个 ESM 包会直接抛
    // ERR_REQUIRE_ESM。放进 exclude 让 rollup 把它们打进产物，转成 CJS。
    //
    // 可行的前提是这几个包里没有 top-level await（TLA 无法降级到 CJS）——
    // 0.84.3 实测为 0 处。升级 pi 版本时要重新确认。
    plugins: [externalizeDepsPlugin({ exclude: ESM_ONLY_DEPS })],

    build: {
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(coreSourceRoot, 'main/index.ts')
        },
        /**
         * 过滤混合导入警告
         * 这些警告是因为同一模块被同时静态和动态导入
         * 对 Electron 主进程无影响，安全忽略
         */
        onwarn(warning, warn) {
          if (warning.message?.includes('dynamic import will not move module')) {
            return
          }
          warn(warning)
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],

    build: {
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(coreSourceRoot, 'preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(coreSourceRoot, 'renderer'),
    server: {
      port: 5280
    },
    resolve: {
      preserveSymlinks: true,
      alias: {
        '@renderer': resolve(coreSourceRoot, 'renderer/src'),
        '@': resolve(coreSourceRoot, 'renderer/src'),
        // simple-mind-map 的 XML 解析器会探测 Node stream；浏览器只需要事件接口。
        stream: resolve(coreSourceRoot, 'renderer/src/shims/nodeStream.ts'),
        // 渲染层引用 src/shared、src/common 等跨进程模块走这条；与 tsconfig 的
        // "@core/*": ["src/*"] 一一对应。
        '@core': coreSourceRoot
      }
    },
    define: {
      /**
       * vue-i18n 默认用 `new Function` 在运行时编译消息，而打包后的页面 CSP 是
       * `script-src 'self'`（见 src/renderer/index.html），会直接抛 EvalError。
       *
       * 这条异常发生在路由守卫的 `i18n.global.t(titleKey)` 里，会中止首次导航，
       * 表现为整个应用白屏。
       *
       * 开启 JIT 后 vue-i18n 改为把消息编译成 AST 再解释执行，不再使用 eval，
       * 与 CSP 兼容。
       */
      __INTLIFY_JIT_COMPILATION__: true
    },
    plugins: [vue()],
    build: {
      emptyOutDir: true,
      /**
       * AudioWorklet 的脚本必须落成**真文件**。
       *
       * Vite 默认会把小于 4KB 的 `?url` 资源内联成 `data:` URL，
       * `pcmCapture.worklet.js` 正好够小。而打包后的页面 CSP 是
       * `script-src 'self'`（见 src/renderer/index.html），Chromium 校验
       * worklet 走的就是 script-src —— `addModule('data:...')` 当场被拦，
       * 表现为正式包点开语音助手起不来，开发期（走 vite dev server，
       * worklet 是个正常的 http 地址）却一切正常。
       */
      assetsInlineLimit: (filePath: string) =>
        filePath.endsWith('.worklet.js') ? false : undefined,
      rollupOptions: {
        input: {
          index: resolve(coreSourceRoot, 'renderer/index.html')
        }
      }
    },
    optimizeDeps: {
      // 避免 Vite 预构建扫描 vue-cropper 的缺失入口导致报错
      exclude: ['vue-cropper']
    },
    css: {
      preprocessorOptions: {
        less: {
          javascriptEnabled: true
        }
      }
    }
  }
})
