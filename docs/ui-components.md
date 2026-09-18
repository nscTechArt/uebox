# UI 组件边界

> **English TL;DR** — The renderer uses **two** component sources on purpose: our own `App*.vue`
> components under `src/renderer/src/components/`, and what is left of `ant-design-vue`.
> The line: **anything the user clicks or that pops up a layer is ours; form inputs are still
> antd.** Three ESLint rules enforce it, so you will get an error (with the right component named
> in the message) rather than a surprise. Never add a new wrapper around an antd component that
> we already replaced — use the `App*` one. See §3 for the lookup table and §4 for the prop
> renames if you are porting old code.

---

## 1. 一句话的界线

> **会被点击、会弹出浮层的交互控件用自建的 `App*`；表单输入类还在 ant-design-vue。**

这条线是有意画在这里的，不是迁移做到一半停下的位置。§6 解释为什么停这儿。

如果你只想知道「我这个东西该用哪个」——跳到 §3 的表，或者干脆直接写，
ESLint 会在你写错的时候告诉你正确的那个叫什么。

## 2. 为什么会有两套

ant-design-vue 最后一个 npm 版本是 **4.2.6（2024-11-11）**，此后没有再发版。
它没有坏，但一个不再发版的 UI 库意味着：Vue 的后续版本、浏览器的新特性、
无障碍规范的更新，都不会再有人替我们跟进。这个项目的判断标准是**三年后还维不维护得动**，
不是眼下省不省事。

除此之外还有一个每天都在付的成本，看 [`antd-override.css`](../src/renderer/src/assets/styles/antd-override.css)
就明白：那个文件里几乎每条规则都带 `!important`。因为 antd 组件自带一套设计 token，
我们的 [`theme.css`](../src/renderer/src/assets/styles/theme.css) 想改它的长相，
只能在外面一层层压过去 —— 压得住的地方好看，压漏一处就露馅
（真实案例：主按钮 hover 时冒出 antd 的蓝底，黑字对比度只剩 2.8:1，鼠标一放上去字就糊）。

自建组件直接读 `var(--color-*)`，没有需要压制的对象。它们看起来更统一，
是因为**本来就长在同一套变量下**，而不是被打服的。

**所以两套并存不是遗留问题，是当前的设计。** 已经换掉的部分拿到了全部好处；
没换的部分（表单输入）风险高、收益低，见 §6。

## 3. 该用哪个

### 自建组件（`src/renderer/src/components/`）

| 组件 | 替代了 | 备注 |
|---|---|---|
| `AppButton` | `a-button` | `icon` 可以传 VNode，也可以用默认插槽 |
| `AppSegmented` | 设置页的 `segmented` / `provider-tabs` | 分段单选，沿用 AI 助手页胶囊外观；`v-model`、`options`、`aria-label`，默认插槽接收 `option` |
| `AppTooltip` | `a-tooltip` | `@floating-ui/dom` 定位 |
| `AppCheckbox` | `a-checkbox` | 支持 `indeterminate`（`aria-checked="mixed"`） |
| `AppSwitch` | `a-switch` | |
| `AppModal` | `a-modal` | 带焦点陷阱、焦点归还、滚动锁计数 |
| `AppDropdown` | `a-dropdown` | 支持 `anchorPoint`（右键菜单跟鼠标） |
| `AppMenu` + `AppMenuItem` / `AppMenuDivider` / `AppMenuItemGroup` / `AppMenuSubmenu` | `a-menu` 一族 | 选中态靠 `provide` 下传，不改子 vnode |
| `AppSpin` | `a-spin` | |
| `AppTag` | `a-tag` | 档位见 [`AppTag.types.ts`](../src/renderer/src/components/AppTag.types.ts) |
| `AppEmpty` | `a-empty` | 图标可用 `#icon` 插槽换掉 |
| `AppAlert` | `a-alert` | 按 `type` 自动选 `role="alert"` / `role="status"` |
| `AppProgress` | `a-progress` | `role="progressbar"` |
| `AppCard` | `a-card` | `hoverable` 时渲染成 `<button>`，键盘能到 |

### 命令式 API（不是组件，是函数）

| 用途 | 走这里 | 不许直接 import |
|---|---|---|
| 确认框 / 提示框 | [`@renderer/utils/dialog`](../src/renderer/src/utils/dialog.ts) —— `confirmDialog` / `errorDialog` / `warningDialog` / `infoDialog` / `successDialog` | `Modal` from `ant-design-vue` |
| 顶部 toast | [`@renderer/utils/messageManager`](../src/renderer/src/utils/messageManager.ts) —— `message.success/error/warning/info/loading` | `message` / `notification` from `ant-design-vue` |

这两个文件**内部仍然包着 antd**。这是故意的：命令式 API 自己挂 DOM、自己读主题上下文，
是最难换的部分。收敛到一个文件之后，将来换实现只改这一处，而不是散落的几十处。
这也是那两条 `no-restricted-imports` 规则唯一的例外名单。

### 右键菜单

全局右键菜单有单独的规范，见 [ContextMenu组件使用规范.md](ContextMenu组件使用规范.md)。
它建在 `AppDropdown` 的 `anchorPoint` 上。

### 图标

用 [Phosphor](https://phosphoricons.com/)（`@phosphor-icons/vue`），不要再引 `@ant-design/icons-vue`。

两条规矩：

1. **按语义挑，不按旧图标的形状挑。** 换图标时回到「这个按钮到底干什么」重新选，
   照着旧图标找一个长得像的，会把上一套的比喻错误原样继承过来
   （真实案例：确认按钮用闪电、上传区画成归档盒、「停止生成」画成禁止标志）。
2. **不要动 `main.ts` 里的 `app.provide('size', '1.15em')`。**
   两套图集的墨迹占框比例不一样（实测 antd 平均 0.957、Phosphor 0.818），
   照搬原来的字号每个图标都会小掉约 17%。删掉它界面不会报错，只会整体变虚，
   而变虚这件事没人会在 code review 里看出来。有测试钉着：
   [`iconScale.test.ts`](../src/renderer/src/assets/styles/iconScale.test.ts)。

## 4. 从 antd 换过来时的改名对照

自建组件不是 antd 的 drop-in 替换 —— 有几个 prop 故意换了名字，因为原名有歧义。
你在老代码或老 PR 里看到左边这些，对应右边：

| ant-design-vue | 我们的 | 为什么改 |
|---|---|---|
| `<a-button type="primary">` | `<AppButton variant="primary">` | `type` 在 HTML 上已经是 `button` / `submit` 的意思了，冲突。原来的 `html-type` 现在叫 `htmlType`，是真正的 HTML `type` |
| `<a-tag color="success">` | `<AppTag tone="success">` | 它从来就不是颜色，是语义档位。取值：`neutral` / `success` / `warning` / `danger` / `info` |
| `<a-modal :footer="null">` | `<AppModal hide-footer>` | 用 `null` 表达「不要这块」是 antd 的怪癖，布尔更直白 |
| `<a-modal ok-type="danger">` | `<AppModal ok-danger>` | 同上 |
| `<a-menu-item key="x">` | `<AppMenuItem item-key="x">` | `key` 是 Vue 保留属性，组件里读不到 |
| `<a-tooltip :align="{ offset: [0, 8] }">` | `<AppTooltip :offset="8">` | 我们只需要沿主轴的一个偏移量 |
| `<a-dropdown :trigger="['contextmenu']">` | `<AppDropdown :anchor-point="{ x, y }">` | 右键菜单要跟着鼠标，不是跟着触发元素 |

其余同名的 prop 行为保持一致（`size` / `disabled` / `loading` / `danger` / `placement` …）。

## 5. 三条 ESLint 规则在管什么

都在 [`eslint.config.mjs`](../eslint.config.mjs)，报错信息里会直接写出该用哪个组件。

| 规则 | 拦什么 | 为什么需要它 |
|---|---|---|
| `vue/no-restricted-html-elements` | `<a-button>` 这类已迁完的标签 | antd 组件是**全局注册**的，不 import 也能跑 —— 没有这条规则，迁完的部分会被后续代码悄悄写回去，而且没有任何信号 |
| `no-restricted-imports` | `import { Button } from 'ant-design-vue'` | 组件式写法绕得过上面那条。迁移时真有 13 处这么写的漏网 |
| `vue/no-undef-components` | 模板里用了没 import 的组件 | Vue 只在运行时警告一句，typecheck 和单测都发现不了，界面表现只是「那个图标不见了」。这条规则抓出过 6 处，其中几处是迁移之前就有的 |

**每迁完一批，就往前两条的名单里加一行。** 这是让进度不会倒退的唯一机制。

## 6. 还没迁的部分，以及为什么停在这里

还剩约 250 处，几乎全是**表单输入**：`a-input` 一族 94、`a-select` 一族 67、
`a-form` 26、`a-descriptions` 9、`a-table` 9、`a-radio` 9。
另外底座层没动：`main.ts` 的 `reset.css` 和 `app.use(Antd)`、`SideMenu.vue` 的导航菜单、
以及 §3 说的那两个命令式接缝内部。

停在这里的三个理由：

1. **表单是唯一「坏了会丢数据」的地方。** 按钮点不开用户立刻看得见；
   输入框吞字是静默的，等发现时数据已经没了。
2. **中文输入法的组合输入（IME composition）在 jsdom 里完全测不出来。**
   我们的测试跑在 happy-dom / jsdom 上，它不做布局、不做命中测试、不模拟输入法。
   这不是「测试没写好」，是这套工具**结构上**看不见这类问题
   —— 迁移过程中两个用户能感知的故障（下拉点不开、浮层挡住按钮）就是从这个洞漏出去的。
   要动表单，得先有真机验收的流程，不能只靠单测绿灯。
3. **收益是二元的。** 只有走到 100%、真的把 `ant-design-vue` 从 package.json 里删掉，
   「摆脱停更依赖」这个好处才兑现。拆到 95% 和拆到 50%，在这一点上没有区别。

**当前状态是稳定态，不是半成品。** 每一类组件只有一个实现 ——
不存在「同一种按钮有两种写法」的混乱，界线一句话说得清（§1），而且有 lint 兜着。

## 7. 要加新组件的话

先问一句：**这个东西 antd 里有没有？**

- **有，而且还没迁**（比如又要一个下拉选择）→ 用 antd 的，别自己造第三套。
  想迁整族的话，那是一次独立的改动，不要夹在功能 PR 里。
- **有，但已经迁了** → 用 `App*` 的。lint 会拦你，报错信息里写着名字。
- **没有** → 自己写，放 `src/renderer/src/components/`，命名 `App<名字>.vue`。要求：
  - 颜色和间距只用 `theme.css` 的变量（硬规则 1，有门禁）
  - 键盘能到、有对应的 ARIA 角色（参考 `AppModal` 的焦点陷阱、`AppMenu` 的 `role="menu"`）
  - 文件头写一段注释说明它替代了什么、有哪些不一样（参考现有组件）
  - 配一个 `*.test.ts`（硬规则 5）

**改设计语言的时候记住要改两个地方**：自建组件改 `theme.css` 的变量，
antd 那半边改 `antd-override.css` 的 `!important`。这是并存的真实代价，
也是将来某天决定继续拆下去时最主要的理由。
