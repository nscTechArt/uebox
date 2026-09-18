# Unreal Box UI 设计标准（可发布版）

版本：v1.0｜覆盖 Web & 桌面（Windows 优先，兼顾 macOS）｜默认深色，支持亮色/高对比｜最低推荐分辨率 1366×768
目标：提供一致、可落地、可验收的视觉与交互规范，并与现有代码 token 对齐。

## 0. 适用对象与更新

- 使用对象：设计 / 前端 / 产品 / 测试。
- 代码基线：CSS 变量位于 `src/renderer/src/assets/styles/theme.css`，主题切换逻辑位于 `src/renderer/src/hooks/useTheme.ts`。
- 版本管理：语义化版本；破坏性变更需附迁移表与过渡期。
- 验收方式：各节列出可衡量要点；完整清单见 §13。

## 1. 品牌基调

- 关键词：专业、冷静、未来、工程可信；避免高饱和霓虹与夸张动效。
- 视觉语言：玻璃拟态 + 微光渐变 + 细描边 + 弱阴影。
- 文案语气：简洁客观、动作导向；少用感叹号。

## 2. 主题模式

- 有四个选项：**跟随系统**（默认）/ 浅色 / 深色 / 自定义。见 `hooks/useTheme.ts`。
  选「跟随系统」时监听 `prefers-color-scheme`，用户在系统设置里切深浅色，应用当场跟上，不用重启。
- 偏好存 localStorage（`app-theme`），同步读取所以启动不闪；读到不认识的值一律回落到跟随系统。
- 自定义主题只开放背景、前景文字和强调色，字体沿用系统设置。颜色存在 `app-custom-theme`；
  应用前必须通过正文 4.5:1、控件 3:1 的对比度检查，运行时再由这三个用户值派生语义色，
  不允许用户输入任意 CSS，也不新增第二套 `data-theme` 切换机制。
- **全应用只有一处写 `data-theme`**，就是 `useTheme.ts`。以前还并行着一套 `data-color-theme`
  （暮影 / 深蓝 / 墨绿 / 黑灰 / 极光 / 黑洞六个配色预设），两套机制同时改颜色，
  谁赢取决于 CSS 里谁写在后面 —— 这类 bug 查起来毫无线索。那套已整体删除。
- 两套主题共用一份颜色真相源：CSS 用 `palette.generated.css`，ant-design-vue 的 `ThemeConfig`
  用同一个生成器吐出的 `palette.generated.ts`。**不要在 `useTheme.ts` 里手写颜色** ——
  以前那里手抄了一遍，把亮色主题的 `colorText` 抄成了 `#FFFFFF`，白底白字。
- 想加主题就在 `palette.generated.css` 里加一个 `[data-theme='xxx']` 块重新指一遍语义变量，
  第一层原色和所有组件一个字都不用动。加之前先想清楚谁来设置这个值 ——
  之前的 `high-contrast` 有整套样式却没有任何地方能选中它，白躺了很久。

## 3. 色彩与 Design Token

内置颜色分两层，都在 `src/renderer/src/assets/styles/palette.generated.css`；自定义主题的用户色值
由 `hooks/customTheme.ts` 校验并在运行时映射到同一组语义变量，不进入生成色板。
**那个文件由 `scripts/gen-palette.mjs` 生成，不要手改** —— 改色改脚本，然后 `pnpm palette`。

### 3.1 两层结构

**第一层 · 原色（primitives）**：只说明「这是什么颜色」，`--n-*`、`--accent-*`、
`--success-*`、`--warning-*`、`--danger-*`。**组件永远不要直接用这一层** ——
组件里一旦出现 `--accent-500`，主题切换就没有接缝了。

**第二层 · 语义色（semantics）**：只说明「用在哪」，指向第一层。**组件只用这一层。**

| 组   | 变量                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| 表面 | `--color-bg-page` / `-surface` / `-surface-hover` / `-raised` / `-sunken` / `-selected` / `-inverse` / `-scrim` / `-overlay` |
| 文字 | `--color-text-primary` / `-secondary` / `-muted` / `-disabled` / `-inverse` / `-on-solid`                                    |
| 描边 | `--color-separator` / `--color-border-subtle` / `--color-border` / `-strong` / `-focus`                                      |
| 强调 | `--color-accent-text` / `-bg` / `-bg-hover` / `-border` / `-solid` / `-solid-hover`                                          |
| 状态 | `--color-{success,warning,danger}-{text,bg,border,solid}` / `--color-warning-on-solid`                                      |
| 物件 | `--color-folder`（文件夹本来就是黄的，这不是状态色）                                                                         |

命名法则 `--color-{角色}-{变体}-{状态}`，一个概念只用一个词：前景一律 `text`，
背景一律 `bg`，描边一律 `border`，品牌色一律 `accent`。
`primary` 只保留一个意思 ——「同组里最显眼的那个」，所以 `--color-text-primary` 是正文，
不存在叫 `--color-primary` 的品牌色。

### 3.2 色相与实测对比度

| 角色   | 色相                 | 深色主题                                       | 亮色主题                                       |
| ------ | -------------------- | ---------------------------------------------- | ---------------------------------------------- |
| 中性   | 纯灰（彩度 0）       | 页面 `#111111`，卡片 `#1c1c1c`，悬停 `#272727` | 页面 `#f7f7f7`，卡片 `#ffffff`，悬停 `#f2f2f2` |
| 强调   | 中性灰（Codex 风格） | 文字 `#fcfcfc`，实心 `#6a6a6a`                 | 文字 `#343434`，实心 `#6a6a6a`                 |
| 成功   | 150°                 | `#27a854`                                      | `#1a7d3d`                                      |
| 警告   | 75°                  | `#f7ad30`                                      | `#906317`                                      |
| 危险   | 27°                  | `#f8554c`                                      | `#d12224`                                      |
| 文件夹 | 85°                  | `#fac134`                                      | `#866617`                                      |

对比要求：正文 ≥4.5:1，大字/图标/控件边界 ≥3:1。
`pnpm palette` 每次生成都会把 41 对实际会叠在一起的前景/背景逐对量一遍，不达标直接失败。

普通实心填充使用 `--color-text-on-solid`（白）。**警告黄是唯一例外**：
`--color-warning-solid` 使用明亮琥珀 `#f7ad30`，文字必须使用
`--color-warning-on-solid`（`#111111`）。把警告黄压暗到能配白字会变成褐色，
失去警告色应有的明亮感；亮黄配深字的对比度为 9.87:1。

**浮在图片 / 画布 / 视频上的控件用 `--color-bg-overlay` + `--color-text-on-solid`。**
它跟主题无关（底下是用户的图，图什么样跟深浅色没关系），两个主题同一个值，
配白字在纯白图上也有 7:1。别拿它当「凹下去一块」用，那是 `--color-bg-sunken`；
也别拿 `--color-bg-scrim` 当它用，scrim 是模态框背后压暗整屏的那层黑纱。

### 3.3 五条硬规则

前四条由 `pnpm verify:colors` 守着，会让门禁直接变红。

1. **组件里不许出现裸写的颜色。** 逐文件棘轮，存量只准变少。
   投影（`box-shadow`）和渐变里的半透明色除外 —— 那里本来就该是半透明色叠在未知背景上。
2. **一个变量只用在它的角色上。** 缺角色就去 `gen-palette.mjs` 加一个，不要借用值相近的变量。
   分隔线拿去当文字色，今天没事，等描边调亮的那天文字跟着一起亮。
3. **`--color-text-disabled` 只准用在真的禁用态上。** 它是整套体系里唯一
   **故意不达标**的文字色（浅色底上 3.03:1），因为 WCAG 把禁用控件排除在外。
   提示语、计数、空状态、时间戳这些是要读的内容，用 `--color-text-muted`（4.62:1）。
   曾经 120 处里有 87 处是拿禁用色写正经内容的。
4. **禁用态不准用 `opacity` 表达。** opacity 把整个元素往**它背后的东西**上拖，
   而背后是什么随主题、随所在面变，结果算不出来 —— 实测主按钮底色与白字压在
   白页上，`opacity: 0.5` 之后底色被冲淡、白字还是白字，对比度从 4.57 掉到 1.96，
   字直接消失；同一行代码在深色主题下只是「看着淡一点」。
   正确写法：`color: var(--color-text-disabled)`，实心按钮再加
   `background: var(--color-bg-surface-hover)` 和 `box-shadow: none`。
5. **深色主题是独立设计的，不是亮色主题反过来。** 深色底上的彩色元素坐在 60~67% 亮度
   （黄色 80%+），那里色域最宽；照搬亮色主题的档位会发灰。

另外，同一条规则里同时写了 `color` 和 `background` 的，门禁会把两个主题
各算一遍对比度，低于 3:1 直接失败（禁用态豁免）。这是唯一能纯静态算准的一类配对。

### 3.4 旧变量名去哪了

这次改造把 138 个旧颜色变量合并成 40 个语义变量。几个容易找不到的：

| 旧名                                                        | 现在                                         | 为什么                                                                                                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--color-brand-*`                                           | `--color-accent-*`                           | 品牌色统一叫 accent；旧色阶 50~300 是紫的、400~900 是蓝的，中途拐了 43°                                                                                                      |
| `--color-accent-*`                                          | `--color-text-muted` / `--color-border` 等   | 旧名装的是黑白灰，不是强调色                                                                                                                                                 |
| `--color-primary`                                           | 按属性分家                                   | 值是深灰 `#343a43`，却有 31 处当文字色（对比度 1.36，看不见）、24 处当描边色                                                                                                 |
| `--color-surface-s0..s4`                                    | `--color-bg-page` / `-surface` / `-raised`   | 编号说不清用途，`s2` 猜不出比 `s1` 高还是低                                                                                                                                  |
| `--color-info`                                              | `--color-accent-text`                        | 全仓库没有一处真的用它表示「提示」，整条色阶删掉                                                                                                                             |
| `--tab-active-bg`                                           | `--color-bg-surface-hover`                   | 旧的那个因为少写一个分号，被上一条声明吞掉了，从来没生效过                                                                                                                   |
| 选中态借用 `--color-accent-bg` / `--color-bg-surface-hover` | `--color-bg-selected` 一族                   | 文档里写着的 `--active-bg` 从来不存在，于是各处自己挑：53 处借强调底（选中就整块变蓝，跟真正的蓝色提示混成一类）、16 处借 hover 底（选中的那条和鼠标划过的那条长得一模一样） |
| `--color-text-on-accent`                                    | `--color-text-on-solid`                      | 它是普通实心填充使用的白字；明亮警告黄单独使用 `--color-warning-on-solid` 深色字                                                                                              |
| 一部分 `--color-bg-scrim`                                   | `--color-bg-overlay` / `-sunken` / `-raised` | 迁移时把所有 `rgba(0,0,0,x)` 都当成 scrim，97 处里只有 17 处真是模态遮罩，其余在浅色主题下变成白纸上的一块深灰                                                               |

## 4. 字体与排版

- 字体：中文 `HarmonyOS Sans SC`，英文 `Segoe UI Variable`；等宽 `JetBrains Mono`。
- 等宽/数字：`font-variant-numeric: tabular-nums` 用于价格、对齐场景。
- 层级（桌面）：Display 56/64，H1 36/40，H2 30/32，H3 24，H4 20，正文 14/16，小字 12；行高 1.5–1.75。
- 混排：中英文留半角空格；长英文允许断词；链接采用单一区分（颜色或下划线）+ hover 明显变化。
- 选区：使用主题选中色，避免与链接混淆。

## 5. 空间、圆角、阴影

- 间距：4pt 主轴，`--space-1..10 = 4..48`，扩展 12/16/20/24。
- 圆角：`--radius-xs 4`，`sm 6`，`md 8`，`lg 8`，`xl 12`，`full 9999`。卡片/容器优先 8/12。
- 阴影：常规 `--shadow-soft`，玻璃卡片 `--shadow-glass`，悬浮强调 `--shadow-pop`，移动端弱化。

## 6. 布局与响应

- 栅格：12 列；容器最大 1280/1440；安全边距 24/32。
- 断点：xs 480 / sm 768 / md 1024 / lg 1280 / xl 1536 / 2xl 1920（见 `layout.css`）。
- Gap：默认 `--grid-gap = var(--space-6)`；小屏可降到 `--space-4`。
- 常用模式：侧栏布局、三栏、卡片自适应网格、头-内容-底布局均提供工具类。
- 滚动：自定义细滚动条；`prefers-reduced-motion` 时禁用平滑滚动。

## 7. 组件外观规范

通用：全部状态覆盖 default/hover/active/focus-visible/disabled，触控最小 44×44。

### 按钮

- 主按钮（`<a-button type="primary">`）：**反相底**，无描边。
  浅色主题近黑配白字，深色主题近白配黑字 —— 靠明度反差跳出来，不是靠颜色。

  |                             | 深色      | 浅色      |
  | --------------------------- | --------- | --------- |
  | `--color-bg-inverse`        | `#fcfcfc` | `#0d0d0d` |
  | `--color-bg-inverse-hover`  | `#dcdcdc` | `#3a3a3a` |
  | 字色 `--color-text-inverse` | `#111111` | `#ffffff` |

  **主按钮不用有色色相。** 全局强调已改为中性灰，主按钮继续用反相底，
  靠明度反差读出「这一屏就点这个」。
  一屏只给一个主按钮，同级的其它操作走次按钮。
  危险主操作除外：`type="primary" danger` 保持红色实心，不走反相底。

- 次按钮（`variant="default"`）：透明背景 + 描边；hover 变浅背景与边框。
- 软按钮（`variant="soft"`）：**填一层浅底，不描边**。`--color-bg-soft`，
  hover 走 `--color-bg-soft-hover`。

  用在「又不是主操作、又需要看着像个按钮」的次动作上：设置页里的
  「复制路径」「打开目录」「添加一行」「重建索引」都归这一档。

  和次按钮的分工看**它站在什么底上**：`default` 描边不填底，适合已经有底色的
  卡片、表单容器；`soft` 填底不描边，适合直接摆在设置页的空白区 —— 那里没有
  边框给它划边界，描边反而显得零碎。

  > 这一档是补出来的。设置页一度有八套各写各的写法（`link-button`、
  > `action-button`、`action-btn`、`ghost-btn`、`archived-btn`、`reset-button`、
  > `primary-btn`、`soft-action-button`），每套在自己的 `<style scoped>` 里定义一遍，
  > 同一页上两个按钮长得不一样，用户会以为它们分量不同。
  > **新的按钮一律用 `AppButton`，不要在面板里再手搓一个 `<button class="...">`。**

- 文本按钮：透明背景 + 颜色变化，hover 有轻微底色。
- 尺寸：S 32 / M 40 / L 48，高度含内边距；圆角随尺寸 12–16。

### 卡片/面板

- 玻璃底：`--glass-bg` + `backdrop-filter` 8–24px，外描边 1px + 内描边 1px。
- 阴影：默认 `--shadow-glass`，hover 微上移 + `--shadow-pop`。
- 结构：header / body / footer 分隔线用 `--color-border-soft`。

### 输入与表单

- 背景：玻璃或浅色透明；描边 1px `--glass-border`；focus 2px 外环（brand/accent）。
- 占位符：对比不超过正文 40%；禁用态降低饱和度与指针。
- 校验：成功/警告/错误边框与提示色使用语义阶梯；错误提供文本+图标，aria-live polite。

### 下拉选择器（Select）

用 ant-design-vue 的 `a-select`，配色全部走 token（`buildTokens` + `antd-override.css`），
不单独覆盖 `.ant-select-*` 的颜色。参照实现：设置 → 通用的主题下拉框，
见 `src/renderer/src/views/System/Preferences/panels/ProfileGeneral.vue`。

**触发框（收起态）**

| 部位     | token                      | 深色      | 浅色      |
| -------- | -------------------------- | --------- | --------- |
| 背景     | `--color-bg-surface`       | `#1c1c1c` | `#ffffff` |
| 描边     | `--color-border`           | `#505050` | `#dcdcdc` |
| 描边悬停 | `--color-border-strong`    | `#6a6a6a` | `#7a7a7a` |
| 文字     | `--color-text-primary`     | `#fcfcfc` | `#111111` |
| 圆角     | 8px（antd `borderRadius`） |           |           |

- focus 态描边色不变，**没有强调色外环**——antd 默认的 focus box-shadow
  已在 `antd-override.css` 里注释掉，跟「交互靠明度和位置，不靠颜色」的取舍一致。
- 右侧箭头图标比正文淡一档，颜色落在 `--color-text-disabled` 附近
  （antd 弱化图标默认走 `colorTextQuaternary`，这里指到这一档，没单独覆盖）。
- 框上方的说明文字（如「主题」）：12px / `font-weight: 500` / `--color-text-muted`，
  `letter-spacing: 0.1em`，`text-transform: uppercase`（中文不显字形，英文标签要留着）。

**下拉面板（展开态）**

| 部位 | token                                         | 深色      | 浅色      |
| ---- | --------------------------------------------- | --------- | --------- |
| 背景 | `--color-bg-raised`                           | `#272727` | `#ffffff` |
| 圆角 | 12px（antd `borderRadiusLG`，比触发框大一档） |           |           |

- 面板是不透明实面，不加 `backdrop-filter`——跟 Tooltip/Modal 的玻璃处理不是一路。
- 阴影目前吃 antd 组件默认值，**没有接到本仓库的 `--shadow-menu`**。
  想让弹层阴影全仓统一，照 Tooltip 的先例，在 `useTheme.ts` 的
  `buildComponents` 里给 `Select` 补一条 `boxShadowSecondary`。

**选项行**

- 默认态：透明底，文字 `--color-text-primary`，`font-weight: 400`。
- 选中项：**只加粗，不换色**（`font-weight: 600`，即 `fontWeightStrong`），
  文字亮度跟未选中的一样——选中靠字重这个信号，不是靠把别的选项文字调暗。
  底色是一块比面板亮、四角 4px 圆角（antd `borderRadiusSM`）的高亮条，
  在面板内四边留白，不贴边。
- 悬停/选中底色目前走 antd 内部派生 token，**没有被这份 palette 显式接管**，
  数值上量不出对应哪个语义 token。要做到「所见即所得可直接照抄」，
  照 Checkbox 的先例在 `useTheme.ts` 加一段 `components.Select`，
  把 hover/选中底显式指到 `--color-bg-surface-hover` / `--color-bg-selected`
  ——跟 §7「分割线与列表」里列表行的通用规则对齐，而不是让 Select 自成一套。
- 展开/收起动效：250ms（`motionDurationMid`）。

### 开关（Switch）

**只有一个实现：`src/renderer/src/components/AppSwitch.vue`。不许再手写。**

在统一之前应用里有 11 套手写开关，轨道 32×18 / 36×20 / 40×20 / 42×24 / 44×24 五种尺寸，
开启态还分成两派 —— 一派实心蓝轨 + 白钮，一派淡蓝轨 + 蓝钮。同一个偏好设置页
上下两行的开关都不是一个东西。

- 尺寸：`middle` 40×22（默认）、`small` 30×18。滑块与轨道内边距 3px / 2px。
- 关：轨道 `--color-bg-surface-hover`，1px `--color-border-strong` 描边，
  滑块 `--color-text-muted`。描边负责 WCAG 1.4.11 要求的 3:1 控件边界 ——
  轨道底色本身跟卡片太接近，靠它撑不住。
- 开：轨道 `--color-switch-checked-solid` 蓝色实心，滑块 `--color-text-on-solid`。
  Switch 是黑白灰商务主题里保留的状态色，用来避免“已开启”和禁用灰混淆；其它强调控件仍走中性灰。
- 开关态不靠颜色单独承载：滑块位置 + 轨道明暗 + 滑块明暗，三重信号。
- 语义上是 `<button role="switch" aria-checked>`，键盘和读屏都能用。
  没有可见文字标签时必须给 `ariaLabel`。
- API 与 `a-switch` 对齐：`v-model:checked`、`disabled`、`@change`，可直接替换。

antd 的 `a-switch` 只剩「带文字标签的模式切换」还在用（资产库标签面板的 全部/任一），
它的配色在 `antd-override.css` 里对齐同一套 token。普通布尔开关一律走 `AppSwitch`。

守卫：`src/renderer/src/components/AppSwitch.test.ts` —— 谁再手写一个带 translateX
滑块的 switch/toggle，测试直接红。

### 复选框（Checkbox）

**用 ant-design-vue 的 `a-checkbox`，配色在 `useTheme.ts` 的 `components.Checkbox` 里统一给。
页面里不许再改 `.ant-checkbox-inner`，也不许写原生 `<input type="checkbox">`。**

- 未选中：方框透明底 + 1px `--color-border-strong` 描边。
  **不能用全局 `colorBorder`** —— 那是 `--color-border`，在深色卡片上只有 2.1:1，
  达不到 WCAG 1.4.11 对控件边界的 3:1，方框会直接消失。
  全局那个也不能整体加重，它同时管输入框和卡片描边，加重了显脏。
- 选中：组件级 `colorPrimary` 使用 `switchChecked` 蓝色状态 token，配 antd 默认的白对勾。
  与 Switch 一致，蓝色只表达明确的布尔选择状态；全局 accent 仍保持中性灰。
- 方框底色是 `transparent`，跟着所在行走 —— 写死一个表面色的话，
  行 hover 变色时方框里会露出一块更暗的方。

统一之前的样子：三个页面各自打补丁修「深色下方框看不见」（侧边栏自定义、
资产筛选面板、笔记来源面板），其中一处顺手把**选中态**也改成了灰底 ——
而对勾是白的，于是勾上跟没勾长得一样。另有 4 处直接用原生 checkbox，
完全不认主题。

守卫：`src/renderer/src/hooks/useTheme.test.ts` —— 描边对比度按两个主题各量一遍，
再扫全仓不许有 `.ant-checkbox-inner` 覆盖和原生 checkbox。

### 标签/Badge

- Tag：玻璃背景，圆角小；状态版用语义浅底+边框。
- Badge：品牌渐变或实体色，10–12px 字号，小圆角；`badge-dot` 用于状态点。

### 分割线与列表

- Divider：1px `--color-border-soft`；竖直分隔线保留 1px。
- 列表/行态：hover 底色 `--color-bg-surface-hover`，选中底色 `--color-bg-selected`（中性灰，不加描边）。

### 选中态（selected）

「选中」是一个会一直留着的状态：侧边栏当前页、筛选器里勾上的那条、列表里被点开的那行。
它跟 hover 不是一个角色 —— hover 是鼠标路过，手一挪就没了；选中是鼠标挪走了还在。
也跟 CSS 的 `:active`（按下去那一瞬间）不是一回事。

| 用途             | token                       | 深色      | 浅色      |
| ---------------- | --------------------------- | --------- | --------- |
| 选中底色         | `--color-bg-selected`       | `#2b2b2b` | `#ededed` |
| 选中项再被 hover | `--color-bg-selected-hover` | `#343434` | `#dcdcdc` |
| 选中项的文字     | `--color-text-selected`     | 同正文    | 同正文    |

**选中态是中性灰，不加描边。** 它只表达「这一项被挑中了」，
不额外引入色相。描边同理：描边是「这是个可点的边界」，
跟选没选中无关，选中不该顺手把边框也改色。所以选中**只改灰度**。

方向跟表面层级一致：深色越选越亮，浅色越选越暗。

三条硬规则：

1. **选中底和 hover 底不许是同一个值。** 键盘停在第一条、鼠标停在第三条时，
   两条一样亮，用户按回车执行哪条只能靠猜。
2. **两者的灰度差得撑得住。** 中性灰没有色相帮忙，全靠亮度差。
   实测浅色 `#f2f2f2` 悬停 ↔ `#ededed` 选中 = 1.046，刚过 1.040 的门槛；
   再近一档（`#efefef`，只差 3 个色阶值）就是 1.027，两个面肉眼分不出来。
   `pnpm palette` 会把这两对逐一量过，不达标直接失败。
3. **画布上的对象选中是另一回事。** 无限画布里的图形、便签没有「底色」可改，
   选中框就是唯一的信号，那里该用 `--color-accent-border` 画描边 ——
   这条规则管的是列表行、卡片、筛选器这类有底色的元素。

不要拿 `--color-accent-bg` 当选中底，也不要拿 `--color-bg-surface-hover` 当选中底。

### Tooltip

- 深色底 `--color-neutral-800`，12px 字号；箭头同色；显示/隐藏 120–160ms。

### Loading

- 细线环，遵循 motion token；`prefers-reduced-motion` 时停转，改用省略号占位。

### 弹层/模态

- 遮罩：透明度 40–60%，可选 8–16px 轻模糊；主体面板不再叠加大模糊，保持清晰对比。
- 关闭：Esc 可用，遮罩可点击关闭（按业务决定）。

## 8. 玻璃拟态与渐变

- 玻璃：底色 `rgba(18,26,46,0.35~0.48)` 级别，可按层级调整；描边外 1px rgba(255,255,255,0.14)，内 1px rgba(255,255,255,0.06)；阴影 0 8px 24px rgba(0,0,0,0.35)。
- 模糊：桌面 16–24px；低性能或 `prefers-reduced-transparency` 降级 8/0，仅保留半透明和描边。
- 渐变：优先 120/135/160°，不超过三色，避免条带；仅用于强调区域。

## 9. 交互与动效

- 时长：入场 240–320ms，悬停 120–160ms，离场 180–220ms；使用 `--motion-fast/normal/slow`。
- 缓动：标准 `cubic-bezier(0.2, 0.8, 0.2, 1)`，轻弹 `cubic-bezier(0.16, 1, 0.3, 1)`。
- 属性：优先 transform/opacity；避免频繁 box-shadow/filter 动画。
- 层级动效：Base → Elevated 淡入+轻上移；Modal 带遮罩淡入；System Toast 自下而上 12px。
- 减少动态：`prefers-reduced-motion` 时移除位移，保留淡入，停用 loading 旋转。

## 10. 可访问性

- 对比：满足 WCAG AA（正文 4.5:1，标题 3:1）。
- 键盘：焦点环统一 2px `--focus-ring`，顺序合理，Esc 关闭弹层。
- 触达：最小点击区域 44×44；提示/错误 aria-live polite。
- 高对比/强制颜色：使用 `prefers-contrast: high` 与 `forced-colors` 分支，避免纯透明。

## 11. 主题实现要点（前端）

- 统一变量来源：`theme.css` 定义全局 CSS 变量；`useTheme.ts` 在应用启动写入 `data-theme`。
- Ant Design 主题：`useTheme.ts` 中的 `themeConfigs` 将 token 映射至 AntD，新增 token 优先补齐 CSS 变量后再映射。
- 背景：`.app-container` 使用主题背景图；保持 `background-attachment: fixed` 谨慎使用，关注性能。
- 禁止：组件内直接写 HEX / rgba；改用语义变量或表面/边框变量。

## 12. 性能与降级

- 模糊与阴影：移动端/低性能设备降级模糊半径或移除模糊；阴影使用低成本阴影或关闭。
- 动画：滚动期间避免重度滤镜；帧预算目标 60fps，动画主线程 ≤4ms/frame。
- 资源：图标优先 SVG `currentColor`；避免内联位图。

## 13. 验收清单（勾选）

- [ ] 深/亮/高对比三主题下，文本/按钮对比满足标准。
- [ ] 按钮、输入、卡片的 hover/active/focus/disabled 反馈一致。
- [ ] 玻璃面板在不支持模糊或低性能下降级为半透明+描边，仍可读。
- [ ] 触控目标 ≥44px，小屏断点 480/768 下无溢出。
- [ ] `prefers-reduced-motion` 生效：移除位移动画与 loading 旋转。
- [ ] 键盘可达，焦点环可见，Esc 关闭弹层/模态。
- [ ] 组件未硬编码色值，均使用 `theme.css` token；AntD 主题映射与 CSS 变量一致。
- [ ] 文案/排版中英文混排正常，行宽与行高在移动端无溢出。

## 14. 参考文件

- CSS 变量与样式：`src/renderer/src/assets/styles/theme.css`，`global.css`，`typography.css`，`layout.css`，`components.css`
- 主题逻辑：`src/renderer/src/hooks/useTheme.ts`
- 旧版设计说明：`docs/虚幻盒子设计规范文档.md`

---

如需扩展：新增 token 先在 `theme.css` 定义并同步到 AntD token 映射；新增组件遵循状态、对比与动效规范，提交前按 §13 清单自测。\*\*\* End Patch
