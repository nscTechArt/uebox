import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/coverage',
      '.tmp',
      'tmp',
      'database',
      '**/.git',
      // Vite 的静态资源直通目录，里面只有第三方 vendored bundle
      // （draco 解码器、ueblueprint），大多已压缩。对它们跑 lint 会产出
      // 八千多条我们既不会也不该修的错误，把真实的代码质量数字淹掉。
      'src/renderer/public'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      // TS 里由编译器负责「标识符是否存在」，而 ESLint 的 no-undef 看不见
      // 环境声明（比如 src/preload/index.d.ts 里 declare global 的 AssetFolder），
      // 只会对着合法的全局类型误报。typescript-eslint 官方也建议在 TS 中关掉它。
      'no-undef': 'off',
      /**
       * 模板里用了没 import 的组件 —— Vue 只在运行时警告一句，
       * typecheck 和单测都发现不了，表现只是「那个元素不见了」。
       * 迁移 196 个按钮那一批就真的漏掉过一个图标，靠人眼没看出来。
       *
       * 忽略名单里是全局注册的：antd 的 a-*（还没换完）、Vue 内置、路由。
       */
      'vue/no-undef-components': [
        'error',
        {
          ignorePatterns: [
            '^a-',
            '^A[A-Z]',
            '^router-',
            '^RouterView$',
            '^RouterLink$',
            '^Teleport$',
            '^Transition',
            '^KeepAlive$',
            '^Suspense$',
            '^component$',
            // vue-i18n 全局注册的翻译组件
            '^i18n-t$'
          ]
        }
      ],
      /**
       * 已经换成自建组件的那些 antd 标签，不许再写回来。
       *
       * antd 的组件是全局注册的，写 `<a-button>` 不需要 import 也能跑 ——
       * 所以没有这条规则的话，迁移完的部分会被后续代码悄悄地一点点写回去，
       * 而且没有任何信号。名单只列**已经迁完**的，还没迁的（a-input、a-select 等）
       * 不在里面；每迁完一批就往这儿加一行。
       */
      'vue/no-restricted-html-elements': [
        'error',
        { element: 'a-button', message: '用 AppButton' },
        { element: 'a-tooltip', message: '用 AppTooltip' },
        { element: 'a-checkbox', message: '用 AppCheckbox' },
        { element: 'a-modal', message: '用 AppModal' },
        { element: 'a-dropdown', message: '用 AppDropdown' },
        { element: 'a-menu', message: '用 AppMenu' },
        { element: 'a-menu-item', message: '用 AppMenuItem' },
        { element: 'a-menu-divider', message: '用 AppMenuDivider' },
        { element: 'a-menu-item-group', message: '用 AppMenuItemGroup' },
        { element: 'a-spin', message: '用 AppSpin' },
        { element: 'a-tag', message: '用 AppTag' },
        { element: 'a-empty', message: '用 AppEmpty' },
        { element: 'a-switch', message: '用 AppSwitch' }
      ],
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  {
    // ant-design-vue 的命令式 API 收敛在自己的封装里，业务代码不许直连。
    //
    // 理由：ant-design-vue 最后一个 npm 版本是 2024-11 的 4.2.6，之后近两年没有代码发版，
    // 迟早要换掉。`Modal.confirm` / `message.*` 这类命令式 API 自己挂 DOM、自己读主题上下文，
    // 是最难换的部分 —— 散在几十个文件里的话换底层就得改几十处。
    // 收敛之后换实现只改一个文件，所以这条规则是那笔投资的看门人。
    //
    // 例外只有封装自己和测试（测试要 spy 底层，那是有意为之）。
    files: ['src/renderer/**/*.{ts,vue}'],
    ignores: [
      'src/renderer/src/utils/dialog.ts',
      'src/renderer/src/utils/messageManager.ts',
      'src/renderer/**/*.test.ts'
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'ant-design-vue',
              importNames: [
                'Modal',
                'message',
                'notification',
                // 下面这些已经有自建组件了。禁 import 而不是只禁 <a-xxx> 标签：
                // 组件式写法（`import { Button }` + `<Button>`）绕得过
                // no-restricted-html-elements —— 迁移时就有 13 处这么写的漏网。
                'Button',
                'Tooltip',
                'Checkbox',
                'Switch',
                'Spin',
                'Tag',
                'Empty',
                'Alert',
                'Progress',
                'Card',
                'Dropdown'
              ],
              message:
                '弹窗走 @renderer/utils/dialog，消息走 @renderer/utils/messageManager，其余用 components/App*.vue —— 别直连 antd，那层是为了将来能换掉它。'
            }
          ]
        }
      ]
    }
  },
  {
    // scripts/ 和 tests/manual/ 下是纯 JS 的构建脚本与手动验证脚手架，
    // 没有类型系统可依托，强制返回类型注解只会逼出一堆 eslint-disable 注释。
    //
    // `**/scripts/` 而不是 `scripts/`：子包（packages/cli）也有自己的构建脚本，
    // 它们和根上那些是同一类东西，没有理由只豁免其中一处。
    files: ['**/scripts/**/*.{js,mjs,cjs}', 'tests/manual/**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // vue/one-component-per-file 是给业务 SFC 定的：一个 .vue 一个组件，别在一个文件里
    // 塞好几个，否则改动的影响面看不出来。测试文件恰恰相反 —— 用 defineComponent 现场造
    // 几个桩组件是标准写法，被测组件要挂载在哪、父组件传什么 props，都得在同一个文件里说清楚。
    //
    // 不加这条的代价是每个这么写的测试都得挂 eslint-disable 注释：基线里已经有 5 个测试
    // 文件在扛这个警告，每新写一个这种测试就多一条。在配置里关一次，比散在测试里关十次干净。
    files: ['**/*.{test,spec}.{ts,js}'],
    rules: {
      'vue/one-component-per-file': 'off'
    }
  },
  {
    files: ['src/preload/**/*.{ts,d.ts}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  eslintConfigPrettier
)
