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

/** 写进 schema 描述里的那句话，两个工具共用 */
export const WIDGET_TYPE_HINT =
  `常用类型：${KNOWN_WIDGET_TYPES.join(' / ')}。` +
  '这张表之外也认 —— 任何 UWidget 子类写类名（去掉 U 前缀，如 InputKeySelector）都会被动态查找，' +
  '包括工程自己写的控件。名字不对时插件会回 Unknown control type，换个写法再试。'
