/**
 * 蓝图代码解析器
 * 从 UE 蓝图导出代码（Begin Object ... End Object）中提取变量和组件引用
 */

import type { FunctionParam } from '@renderer/views/BlueprintLibrary/types/blueprint'

export interface ExtractedVariable {
  id: string
  name: string
  type: string
  /** 容器类型：Array / Set / Map */
  containerType?: 'Array' | 'Set' | 'Map'
  /** 对象/结构体的子类型名称，如 APlayerHUD、FDataTableRowHandle */
  subType?: string
  /** 默认值 */
  defaultValue?: string
}

export interface ExtractedComponent {
  id: string
  name: string
  componentClass: string
}

// ========== PinCategory → 变量类型映射 ==========
const PIN_CATEGORY_MAP: Record<string, string> = {
  bool: 'Boolean',
  byte: 'Byte',
  int: 'Integer',
  int64: 'Integer64',
  real: 'Float',
  float: 'Float',
  double: 'Double',
  name: 'Name',
  string: 'String',
  text: 'Text',
  struct: 'Struct',
  object: 'Object',
  class: 'Class',
  interface: 'Interface',
  enum: 'Enum',
  wildcard: 'Object'
}

// 从 PinSubCategoryObject 中提取更精确的类型
const STRUCT_TYPE_MAP: Record<string, string> = {
  Vector: 'Vector',
  Rotator: 'Rotator',
  Transform: 'Transform',
  LinearColor: 'LinearColor',
  Color: 'Color',
  Vector2D: 'Vector',
  Vector4: 'Vector'
}

function inferPinValueType(pinContent: string): {
  type: string
  containerType?: 'Array' | 'Set' | 'Map'
  subType?: string
} {
  const catMatch = pinContent.match(/PinType\.PinCategory="([^"]+)"/)
  const subObjMatch = pinContent.match(/PinType\.PinSubCategoryObject=([^,)]+)/)
  const category = catMatch?.[1] ?? 'object'
  const subObj = subObjMatch ? subObjMatch[1] : 'None'

  let type = 'Object'
  let subType: string | undefined

  if (category === 'struct' && subObj && subObj !== 'None') {
    for (const [key, mappedType] of Object.entries(STRUCT_TYPE_MAP)) {
      if (subObj.includes(key)) {
        type = mappedType
        break
      }
    }
    if (type === 'Object') {
      type = 'Struct'
      const structNameMatch = subObj.match(/\.(\w+)["']?$/)
      if (structNameMatch) subType = structNameMatch[1]
    }
  } else if (category === 'real') {
    const subCatMatch = pinContent.match(/PinType\.PinSubCategory="([^"]*)"/)
    type = subCatMatch && subCatMatch[1] === 'double' ? 'Double' : 'Float'
  } else if (category === 'object' && subObj && subObj !== 'None') {
    type = 'Object'
    const objNameMatch = subObj.match(/\.(\w+)["']?$/)
    if (objNameMatch) subType = objNameMatch[1]
  } else if (category === 'enum' && subObj && subObj !== 'None') {
    type = 'Enum'
    const enumNameMatch = subObj.match(/\.(\w+)["']?$/)
    if (enumNameMatch) subType = enumNameMatch[1]
  } else {
    type = PIN_CATEGORY_MAP[category] || 'Object'
  }

  let containerType: 'Array' | 'Set' | 'Map' | undefined
  const containerTypeMatch = pinContent.match(/PinType\.ContainerType=(\w+)/)
  if (containerTypeMatch && containerTypeMatch[1] !== 'None') {
    const parsed = containerTypeMatch[1]
    if (parsed === 'Array' || parsed === 'Set' || parsed === 'Map') {
      containerType = parsed
    }
  }

  return { type, containerType, subType }
}

function parseFunctionParamsFromNodeBody(
  nodeBody: string,
  direction: 'EGPD_Input' | 'EGPD_Output'
): FunctionParam[] {
  const params: FunctionParam[] = []
  const allPins = Array.from(nodeBody.matchAll(/^\s*CustomProperties Pin \((.*)\)\s*$/gm))

  for (const pinMatch of allPins) {
    const pinContent = pinMatch[1]
    const pinNameMatch = pinContent.match(/PinName="([^"]+)"/)
    if (!pinNameMatch) continue

    const pinName = pinNameMatch[1]
    const pinDirection = /Direction="([^"]+)"/.exec(pinContent)?.[1] ?? 'EGPD_Input'
    const isExec = /PinType\.PinCategory="exec"/.test(pinContent)
    const isSelfPin = pinName === 'self'
    if (isExec || isSelfPin || pinDirection !== direction) continue

    const inferred = inferPinValueType(pinContent)
    const defaultValue = /DefaultValue="([^"]*)"/.exec(pinContent)?.[1]
    params.push({
      name: pinName,
      type: inferred.type,
      defaultValue
    })
  }

  return params
}

/**
 * 从蓝图代码中提取变量引用
 * 扫描 K2Node_VariableGet / K2Node_VariableSet 节点
 */
export function extractVariablesFromCode(code: string): ExtractedVariable[] {
  if (!code) return []

  const variables = new Map<string, ExtractedVariable>()

  // 匹配 K2Node_VariableGet 或 K2Node_VariableSet 的完整 Begin Object ... End Object 块
  const nodeRegex = /Begin Object[^\n]*K2Node_Variable(?:Get|Set)[^\n]*\n([\s\S]*?)End Object/g

  let nodeMatch: RegExpExecArray | null
  while ((nodeMatch = nodeRegex.exec(code)) !== null) {
    const nodeBody = nodeMatch[1]

    // 提取 VariableReference 中的 MemberName
    const memberNameMatch = nodeBody.match(/VariableReference=\([^)]*MemberName="([^"]+)"/)
    if (!memberNameMatch) continue

    const varName = memberNameMatch[1]
    if (variables.has(varName)) continue

    // 尝试从该节点的非 exec/self pin 推断类型
    let varType = 'Object'
    let containerType: 'Array' | 'Set' | 'Map' | undefined
    let subType: string | undefined
    let defaultValue: string | undefined

    // 遍历所有 Pin，跳过 self 和 exec，找到实际变量值 pin
    let foundVarPin = false

    const allPins = Array.from(nodeBody.matchAll(/^\s*CustomProperties Pin \((.*)\)\s*$/gm))
    for (const pinMatch of allPins) {
      if (foundVarPin) break
      const pinContent = pinMatch[1]

      // 跳过 self pin
      if (/PinName="self"/.test(pinContent)) continue
      // 跳过 exec pin
      if (/PinCategory="exec"/.test(pinContent)) continue
      // 跳过 output exec (VariableSet 的 "then" pin)
      if (/PinName="execute"/.test(pinContent)) continue

      foundVarPin = true
      const inferred = inferPinValueType(pinContent)
      varType = inferred.type
      containerType = inferred.containerType
      subType = inferred.subType
    }

    // 提取默认值
    const defaultMatch = nodeBody.match(/DefaultValue="([^"]*)"/)
    if (defaultMatch && defaultMatch[1]) {
      defaultValue = defaultMatch[1]
    }

    variables.set(varName, {
      id: `var-${varName}`,
      name: varName,
      type: varType,
      containerType,
      subType,
      defaultValue
    })
  }

  return Array.from(variables.values())
}

/**
 * 从蓝图代码中提取组件引用
 * 扫描节点中对组件类的引用（PinSubCategoryObject 包含 Component）
 */
export function extractComponentsFromCode(code: string): ExtractedComponent[] {
  if (!code) return []

  const components = new Map<string, ExtractedComponent>()

  // 方法1: 匹配 Target pin 中的组件类引用
  // PinFriendlyName 为 Target，且 PinSubCategoryObject 包含 Component
  const componentPinRegex =
    /PinName="self"[^)]*PinSubCategoryObject=[^']*'[^"]*"\/Script\/Engine\.([^"]*Component[^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = componentPinRegex.exec(code)) !== null) {
    const className = match[1]
    if (!components.has(className)) {
      components.set(className, {
        id: `comp-${className}`,
        name: className,
        componentClass: className
      })
    }
  }

  // 方法2: 匹配 MemberParent 中的组件类引用
  const memberParentRegex = /MemberParent=[^']*'[^"]*"\/Script\/Engine\.([^"]*Component[^"]*)"/g
  while ((match = memberParentRegex.exec(code)) !== null) {
    const className = match[1]
    if (!components.has(className)) {
      components.set(className, {
        id: `comp-${className}`,
        name: className,
        componentClass: className
      })
    }
  }

  return Array.from(components.values())
}

export function extractFunctionSignatureFromCode(code: string): {
  inputs: FunctionParam[]
  outputs: FunctionParam[]
} {
  if (!code) {
    return { inputs: [], outputs: [] }
  }

  const functionEntryMatch = code.match(
    /Begin Object[^\n]*K2Node_FunctionEntry[^\n]*\n([\s\S]*?)End Object/
  )
  const functionResultMatch = code.match(
    /Begin Object[^\n]*K2Node_FunctionResult[^\n]*\n([\s\S]*?)End Object/
  )

  const inputs = functionEntryMatch
    ? parseFunctionParamsFromNodeBody(functionEntryMatch[1], 'EGPD_Output')
    : []
  const outputs = functionResultMatch
    ? parseFunctionParamsFromNodeBody(functionResultMatch[1], 'EGPD_Input')
    : []

  return { inputs, outputs }
}

/**
 * 从多段代码中聚合提取变量
 */
export function extractVariablesFromCodes(codes: string[]): ExtractedVariable[] {
  const allVars = new Map<string, ExtractedVariable>()
  for (const code of codes) {
    for (const v of extractVariablesFromCode(code)) {
      if (!allVars.has(v.name)) {
        allVars.set(v.name, v)
      }
    }
  }
  return Array.from(allVars.values())
}

/**
 * 从多段代码中聚合提取组件
 */
export function extractComponentsFromCodes(codes: string[]): ExtractedComponent[] {
  const allComps = new Map<string, ExtractedComponent>()
  for (const code of codes) {
    for (const c of extractComponentsFromCode(code)) {
      if (!allComps.has(c.name)) {
        allComps.set(c.name, c)
      }
    }
  }
  return Array.from(allComps.values())
}

/**
 * 压缩蓝图代码：去除噪音字段，保留语义信息
 * 典型压缩率 60-70%，AI 仍能理解节点逻辑和连接关系
 */
export function compressBlueprintCode(code: string): string {
  if (!code) return ''

  let result = code

  // 1) 去掉画布位置（对理解逻辑无用）
  result = result.replace(/\s+NodePos[XY]=-?\d+/g, '')

  // 2) 去掉所有 GUID（NodeGuid, PersistentGuid）
  result = result.replace(/\s+NodeGuid=[A-F0-9]+/g, '')
  result = result.replace(/,?PersistentGuid=[A-F0-9]+/g, '')

  // 3) 简化 PinId（保留引用关系但缩短 hex）
  // PinId 在 LinkedTo 中被引用，所以需要保持一致性。
  // 策略：保留 PinId 但不缩短（保持 LinkedTo 引用完整性）

  // 4) 去掉默认值为 false 的 bool 标记（几乎总是 false）
  result = result.replace(/,?bHidden=False/g, '')
  result = result.replace(/,?bNotConnectable=False/g, '')
  result = result.replace(/,?bDefaultValueIsReadOnly=False/g, '')
  result = result.replace(/,?bDefaultValueIsIgnored=False/g, '')
  result = result.replace(/,?bAdvancedView=False/g, '')
  result = result.replace(/,?bOrphanedPin=False/g, '')

  // 5) 去掉 PinType 中几乎总是 false/None 的字段
  result = result.replace(/,?PinType\.bIsReference=False/g, '')
  result = result.replace(/,?PinType\.bIsConst=False/g, '')
  result = result.replace(/,?PinType\.bIsWeakPointer=False/g, '')
  result = result.replace(/,?PinType\.bIsUObjectWrapper=False/g, '')
  result = result.replace(/,?PinType\.bSerializeAsSinglePrecisionFloat=False/g, '')

  // 6) 去掉空值的类型元数据
  result = result.replace(/,?PinType\.PinSubCategory=""/g, '')
  result = result.replace(/,?PinType\.PinSubCategoryObject=None/g, '')
  result = result.replace(/,?PinType\.PinSubCategoryMemberReference=\(\)/g, '')
  result = result.replace(/,?PinType\.PinValueType=\(\)/g, '')
  result = result.replace(/,?PinType\.ContainerType=None/g, '')

  // 7) 去掉 PinToolTip（UI 提示文本）
  result = result.replace(/,?PinToolTip="[^"]*"/g, '')

  // 8) 去掉 PinFriendlyName 的 NSLOCTEXT 包装，只保留可读名
  result = result.replace(
    /PinFriendlyName=NSLOCTEXT\("[^"]*",\s*"[^"]*",\s*"([^"]*)"\)/g,
    'PinFriendlyName="$1"'
  )

  // 9) 去掉 AutogeneratedDefaultValue（有 DefaultValue 就够了）
  result = result.replace(/,?AutogeneratedDefaultValue="[^"]*"/g, '')

  // 10) 压缩连续空白
  result = result.replace(/[ \t]+/g, ' ')
  result = result.replace(/\n{3,}/g, '\n\n')

  // 11) 去掉空的 CustomProperties Pin 尾部逗号噪音
  result = result.replace(/,+\)/g, ')')

  return result.trim()
}

/**
 * 从蓝图代码中统计节点数量
 * 统计 Begin Object ... End Object 块的数量
 */
export function countNodesFromCode(code: string): number {
  if (!code) return 0
  // 同时匹配 Class="..." (ueblueprint序列化) 和 Class=/Script/... (UE原始T3D)
  const matches = code.match(/Begin Object[^\n]*Class[=]/g)
  return matches ? matches.length : 0
}

// ========== 节点类型 → 可读名称映射 ==========
const NODE_CLASS_LABEL: Record<string, string> = {
  K2Node_Event: 'Event',
  K2Node_CustomEvent: 'CustomEvent',
  K2Node_FunctionEntry: 'Entry',
  K2Node_FunctionResult: 'Return',
  K2Node_CallFunction: 'Call',
  K2Node_IfThenElse: 'Branch',
  K2Node_SwitchEnum: 'Switch',
  K2Node_SwitchInteger: 'SwitchInt',
  K2Node_SwitchString: 'SwitchStr',
  K2Node_SwitchName: 'SwitchName',
  K2Node_Select: 'Select',
  K2Node_MacroInstance: 'Macro',
  K2Node_ForEachLoop: 'ForEach',
  K2Node_WhileLoop: 'While',
  K2Node_Sequence: 'Sequence',
  K2Node_ExecutionSequence: 'Sequence',
  K2Node_MultiGate: 'MultiGate',
  K2Node_Timeline: 'Timeline',
  K2Node_Delay: 'Delay',
  K2Node_SpawnActor: 'SpawnActor',
  K2Node_DynamicCast: 'Cast',
  K2Node_CastByteToEnum: 'CastToEnum',
  K2Node_MakeArray: 'MakeArray',
  K2Node_GetArrayItem: 'GetArrayItem',
  K2Node_CommutativeAssociativeBinaryOperator: 'MathOp',
  K2Node_VariableSet: 'Set',
  K2Node_VariableGet: 'Get',
  GameplayTagsK2Node_SwitchGameplayTag: 'SwitchGameplayTag',
  K2Node_GetSubsystem: 'GetSubsystem',
  K2Node_CreateDelegate: 'CreateDelegate',
  K2Node_AssignDelegate: 'BindEvent',
  K2Node_AddComponent: 'AddComponent',
  K2Node_SetFieldsInStruct: 'SetFields',
  K2Node_BreakStruct: 'BreakStruct',
  K2Node_MakeStruct: 'MakeStruct'
}

interface ParsedNode {
  name: string
  label: string
  /** exec output pin ids → linked target node name + pin id */
  execOuts: string[]
}

/**
 * 从蓝图代码中提取执行流摘要
 * 解析节点和 exec pin 的 LinkedTo 关系，输出精简的执行链
 */
export function extractFlowSummary(code: string): string {
  if (!code) return ''

  // 1) 解析所有节点：name → {label, execOuts}
  // 同时支持 Class="..." (ueblueprint序列化) 和 Class=/Script/... (UE原始T3D)
  const nodeRegex =
    /Begin Object[^\n]*Class="?[^"\n]*\.(\w+)"?[^\n]*Name="(\w+)"([\s\S]*?)End Object/g
  const nodes = new Map<string, ParsedNode>()
  // pinId → node name (反向索引，用于解析 LinkedTo)
  const pinToNode = new Map<string, string>()

  let m: RegExpExecArray | null
  while ((m = nodeRegex.exec(code)) !== null) {
    const nodeClass = m[1]
    const nodeName = m[2]
    const body = m[3]

    // 生成可读标签
    let label = NODE_CLASS_LABEL[nodeClass] || nodeClass.replace(/^K2Node_/, '')

    // 对 CallFunction 节点，提取 MemberName 作为标签
    if (nodeClass === 'K2Node_CallFunction') {
      const fnMatch = body.match(/MemberName="([^"]+)"/)
      if (fnMatch) label = fnMatch[1]
    }
    // 对 Event 节点，提取 EventReference 的 MemberName
    if (nodeClass === 'K2Node_Event' || nodeClass === 'K2Node_CustomEvent') {
      const evMatch =
        body.match(/EventReference=\([^)]*MemberName="([^"]+)"/) ||
        body.match(/CustomFunctionName="([^"]+)"/)
      if (evMatch) label = `Event:${evMatch[1]}`
    }
    // 对 VariableSet，提取变量名
    if (nodeClass === 'K2Node_VariableSet') {
      const varMatch = body.match(/VariableReference=\([^)]*MemberName="([^"]+)"/)
      if (varMatch) label = `Set:${varMatch[1]}`
    }

    // 收集所有 pin id → node name
    const pinIdRegex = /PinId=([A-F0-9]+)/g
    let pm: RegExpExecArray | null
    while ((pm = pinIdRegex.exec(body)) !== null) {
      pinToNode.set(pm[1], nodeName)
    }

    // 收集 exec output pins 的 LinkedTo 目标
    // 通用方案：匹配所有含 PinCategory="exec" 且带 LinkedTo 的 pin，排除输入方向
    const execOuts: string[] = []
    const allExecPinRegex =
      /CustomProperties Pin \(([^)]*PinCategory="exec"[^)]*LinkedTo=\([^)]+\)[^)]*|[^)]*LinkedTo=\([^)]+\)[^)]*PinCategory="exec"[^)]*)\)/g
    let eo: RegExpExecArray | null
    while ((eo = allExecPinRegex.exec(body)) !== null) {
      const pinContent = eo[1]
      // 跳过输入方向的 exec pin
      if (pinContent.includes('Direction="EGPD_Input"')) continue
      // 提取 LinkedTo 中的目标节点
      const linkedMatch = pinContent.match(/LinkedTo=\(([^)]+)\)/)
      if (!linkedMatch) continue
      const targets = linkedMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const t of targets) {
        const parts = t.split(' ')
        if (parts.length >= 1 && !execOuts.includes(parts[0])) {
          execOuts.push(parts[0])
        }
      }
    }

    nodes.set(nodeName, { name: nodeName, label, execOuts })
  }

  if (nodes.size === 0) return ''

  // 2) 构建执行链：从入口节点开始，BFS 追踪所有分支
  const visited = new Set<string>()
  const chains: string[] = []

  // 找入口节点（Event / FunctionEntry / 无 exec input 的节点）
  const entryNodes = [...nodes.values()].filter(
    (n) => n.label.startsWith('Event:') || n.label === 'Entry' || n.label.startsWith('CustomEvent')
  )
  // 如果没找到显式入口，取第一个有 execOuts 的节点
  if (entryNodes.length === 0) {
    const first = [...nodes.values()].find((n) => n.execOuts.length > 0)
    if (first) entryNodes.push(first)
  }

  /**
   * 递归构建执行链，支持多分支（Switch/Branch/Sequence 等）
   * prefix: 当前已走过的链前缀
   * depth: 防止过深递归
   */
  function buildChain(current: ParsedNode, prefix: string[], depth: number): void {
    if (depth > 25 || visited.has(current.name)) {
      if (prefix.length > 0) chains.push(prefix.join(' → ') + ' → ...')
      return
    }
    visited.add(current.name)
    const path = [...prefix, current.label]

    if (current.execOuts.length === 0) {
      // 叶子节点，完成一条链
      chains.push(path.join(' → '))
      return
    }

    if (current.execOuts.length === 1) {
      // 单路径，继续线性追踪
      const next = nodes.get(current.execOuts[0])
      if (next) {
        buildChain(next, path, depth + 1)
      } else {
        chains.push(path.join(' → '))
      }
    } else {
      // 多分支节点（Switch/Branch/Sequence）
      // 先输出到达分支点的路径
      for (const outName of current.execOuts) {
        const next = nodes.get(outName)
        if (next && !visited.has(next.name)) {
          buildChain(next, path, depth + 1)
        }
      }
      // 如果所有分支都已访问过，至少输出到分支节点的路径
      if (chains.length === 0 || !chains[chains.length - 1]?.startsWith(path.join(' → '))) {
        if (current.execOuts.every((o) => visited.has(o) || !nodes.has(o))) {
          chains.push(path.join(' → ') + ' → [多分支]')
        }
      }
    }
  }

  for (const entry of entryNodes) {
    buildChain(entry, [], 0)
  }

  // 去重并限制总条数
  const uniqueChains = [...new Set(chains)]
  return uniqueChains.slice(0, 15).join('\n')
}

/**
 * 从多段代码中聚合提取执行流摘要
 */
export function extractFlowSummaryFromCodes(codes: Array<{ name: string; code: string }>): string {
  const results: string[] = []
  for (const { name, code } of codes) {
    const flow = extractFlowSummary(code)
    if (flow) {
      results.push(`[${name}] ${flow}`)
    }
  }
  return results.join('\n')
}
