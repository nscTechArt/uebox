/**
 * 控件类型：插件认什么，这里就说什么。
 *
 * ## 为什么单独抽出来
 *
 * 原来 `widget_add_child` 的 `control_type` 是个 12 项的 `z.enum`，
 * `widget_create` 的 `root_type` 更只有 4 项。而插件侧（`FindWidgetClass`）
 * 认 24 个具名类型，认不出来时还会按 `U<名字>` 去引擎里动态查一遍，
 * **任何 UWidget 子类都能建** —— 包括工程自己写的控件。
 *
 * 中间这一层枚举把 ScrollBox、EditableTextBox、ComboBox、GridPanel、WrapBox
 * 全挡在外面：滚动列表做不了，输入框做不了，网格布局做不了。挡的不是错误用法，
 * 是引擎本来就支持、插件也早就实现了的东西 —— 模型甚至看不到这些名字存在。
 *
 * 所以这里改成开放字符串 + 把已知名单写进描述：**认得的照样有引导，
 * 认不得的不再一刀切**。给错了插件会回一句 `Unknown control type: X`，
 * 那比 schema 校验直接拒掉更有用 —— 至少模型知道自己该换个名字。
 *
 * ## 2026-10-20 更正
 *
 * 上面说的「按 `U<名字>` 动态查」其实从来没查到过东西：类对象的名字本来就不带
 * U 前缀（UButton 的类对象叫 Button）。工程自己做的控件蓝图（CommonUI 项目里的
 * WB_Text_Button）也不在任何查找路径上。插件改成 `ResolveWidgetClass`：原生类名、
 * 控件蓝图资产名、资产或类路径都认，重名时列出候选让调用方给路径。
 */

/** 插件 `FindWidgetClass` 里写死的映射表（UAL_WidgetCommands.cpp） */
export const KNOWN_WIDGET_TYPES = [
  'Button',
  'TextBlock',
  'RichTextBlock',
  'Image',
  'CanvasPanel',
  'VerticalBox',
  'HorizontalBox',
  'Overlay',
  'Border',
  'ScrollBox',
  'SizeBox',
  'Spacer',
  'ProgressBar',
  'Slider',
  'CheckBox',
  'ComboBoxString',
  'EditableText',
  'EditableTextBox',
  'SpinBox',
  'GridPanel',
  'WrapBox',
  'UniformGridPanel'
] as const

/** 写进 schema 描述里的那句话，几个工具共用 */
export const WIDGET_TYPE_HINT =
  `常用类型：${KNOWN_WIDGET_TYPES.join(' / ')}。` +
  '表外的也认：引擎和插件里的控件类写类名（去掉 U 前缀，如 CommonButtonBase），' +
  '工程自己做的控件蓝图写资产名（WB_Text_Button）或路径（/Game/UI/WB_Text_Button）。' +
  '名字不对或重名时插件会说怎么改。'
