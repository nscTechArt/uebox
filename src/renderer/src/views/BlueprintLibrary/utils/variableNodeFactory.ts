import type { ExtractedVariable } from '@renderer/views/BlueprintLibrary/utils/blueprintCodeParser'
import type { FunctionParam } from '@renderer/views/BlueprintLibrary/types/blueprint'

export type VariableNodeAccessType = 'get' | 'set'

interface CommentNodeClipboardOptions {
  nodePosX?: number
  nodePosY?: number
  comment?: string
}

interface PinTypeDescriptor {
  category: string
  subCategory: string
  subCategoryObject: string
  containerType: 'None' | 'Array' | 'Set' | 'Map'
  isReference?: boolean
}

interface PinTemplateOptions {
  name: string
  direction: 'EGPD_Input' | 'EGPD_Output'
  category: string
  subCategory?: string
  subCategoryObject?: string
  containerType?: PinTypeDescriptor['containerType']
  defaultValue?: string
  friendlyName?: string
  tooltip?: string
  isReference?: boolean
  hidden?: boolean
}

function createGuid(): string {
  return crypto.randomUUID().replace(/-/g, '').toUpperCase()
}

function createObjectName(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`
}

function toContainerType(
  containerType?: ExtractedVariable['containerType']
): PinTypeDescriptor['containerType'] {
  if (containerType === 'Array' || containerType === 'Set' || containerType === 'Map') {
    return containerType
  }
  return 'None'
}

function escapeBlueprintString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function toNodeCoordinate(value: number | undefined): number {
  return Number.isFinite(value) ? Math.round(value as number) : 0
}

export function createCommentNodeClipboardText(options: CommentNodeClipboardOptions = {}): string {
  const objectName = createObjectName('EdGraphNode_Comment')
  const nodePosX = toNodeCoordinate(options.nodePosX)
  const nodePosY = toNodeCoordinate(options.nodePosY)
  const comment = options.comment ?? '\u6ce8\u91ca'

  return [
    `Begin Object Class=/Script/UnrealEd.EdGraphNode_Comment Name="${objectName}"`,
    '   CommentColor=(R=0.150000,G=0.150000,B=0.150000,A=0.500000)',
    '   bCommentBubbleVisible_InDetailsPanel=False',
    `   NodePosX=${nodePosX}`,
    `   NodePosY=${nodePosY}`,
    '   bCommentBubblePinned=False',
    '   bCommentBubbleVisible=False',
    `   NodeComment="${escapeBlueprintString(comment)}"`,
    `   NodeGuid=${createGuid()}`,
    'End Object'
  ].join('\n')
}

function getPinTypeDescriptor(
  variable: Pick<ExtractedVariable, 'type' | 'containerType'>
): PinTypeDescriptor {
  const containerType = toContainerType(variable.containerType)

  switch (variable.type) {
    case 'Boolean':
      return { category: 'bool', subCategory: '', subCategoryObject: 'None', containerType }
    case 'Byte':
      return { category: 'byte', subCategory: '', subCategoryObject: 'None', containerType }
    case 'Integer':
      return { category: 'int', subCategory: '', subCategoryObject: 'None', containerType }
    case 'Integer64':
      return { category: 'int64', subCategory: '', subCategoryObject: 'None', containerType }
    case 'Float':
      return { category: 'real', subCategory: 'float', subCategoryObject: 'None', containerType }
    case 'Double':
      return { category: 'real', subCategory: 'double', subCategoryObject: 'None', containerType }
    case 'Name':
      return { category: 'name', subCategory: '', subCategoryObject: 'None', containerType }
    case 'String':
      return { category: 'string', subCategory: '', subCategoryObject: 'None', containerType }
    case 'Text':
      return { category: 'text', subCategory: '', subCategoryObject: 'None', containerType }
    case 'Vector':
      return {
        category: 'struct',
        subCategory: '',
        subCategoryObject: `/Script/CoreUObject.ScriptStruct'"/Script/CoreUObject.Vector"'`,
        containerType
      }
    case 'Rotator':
      return {
        category: 'struct',
        subCategory: '',
        subCategoryObject: `/Script/CoreUObject.ScriptStruct'"/Script/CoreUObject.Rotator"'`,
        containerType
      }
    case 'Transform':
      return {
        category: 'struct',
        subCategory: '',
        subCategoryObject: `/Script/CoreUObject.ScriptStruct'"/Script/CoreUObject.Transform"'`,
        containerType
      }
    case 'LinearColor':
      return {
        category: 'struct',
        subCategory: '',
        subCategoryObject: `/Script/CoreUObject.ScriptStruct'"/Script/CoreUObject.LinearColor"'`,
        containerType
      }
    case 'Color':
      return {
        category: 'struct',
        subCategory: '',
        subCategoryObject: `/Script/CoreUObject.ScriptStruct'"/Script/CoreUObject.Color"'`,
        containerType
      }
    case 'Class':
      return { category: 'class', subCategory: '', subCategoryObject: 'None', containerType }
    case 'Interface':
      return { category: 'interface', subCategory: '', subCategoryObject: 'None', containerType }
    case 'Enum':
      return { category: 'enum', subCategory: '', subCategoryObject: 'None', containerType }
    case 'Struct':
      return { category: 'struct', subCategory: '', subCategoryObject: 'None', containerType }
    case 'Object':
    default:
      return { category: 'object', subCategory: '', subCategoryObject: 'None', containerType }
  }
}

function createExecPin(pinName: string, direction: 'EGPD_Input' | 'EGPD_Output'): string {
  const directionFragment = direction === 'EGPD_Output' ? ',Direction="EGPD_Output"' : ''
  return `   CustomProperties Pin (PinId=${createGuid()},PinName="${pinName}"${directionFragment},PinType.PinCategory="exec",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None,PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=None,PinType.bIsReference=False,PinType.bIsConst=False,PinType.bIsWeakPointer=False,PinType.bIsUObjectWrapper=False,PinType.bSerializeAsSinglePrecisionFloat=False,PersistentGuid=00000000000000000000000000000000,bHidden=False,bNotConnectable=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)`
}

function createTypedPin(options: PinTemplateOptions): string {
  const directionFragment = options.direction === 'EGPD_Output' ? ',Direction="EGPD_Output"' : ''
  const defaultValueFragment = options.defaultValue
    ? `,DefaultValue="${escapeBlueprintString(options.defaultValue)}",AutogeneratedDefaultValue="${escapeBlueprintString(options.defaultValue)}"`
    : ''
  const friendlyNameFragment = options.friendlyName
    ? `,PinFriendlyName=${options.friendlyName}`
    : ''
  const tooltipFragment = options.tooltip
    ? `,PinToolTip="${escapeBlueprintString(options.tooltip)}"`
    : ''
  const hiddenFragment = `,bHidden=${options.hidden ? 'True' : 'False'}`

  return `   CustomProperties Pin (PinId=${createGuid()},PinName="${escapeBlueprintString(options.name)}"${friendlyNameFragment}${tooltipFragment}${directionFragment},PinType.PinCategory="${options.category}",PinType.PinSubCategory="${options.subCategory ?? ''}",PinType.PinSubCategoryObject=${options.subCategoryObject ?? 'None'},PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=${options.containerType ?? 'None'},PinType.bIsReference=${options.isReference ? 'True' : 'False'},PinType.bIsConst=False,PinType.bIsWeakPointer=False,PinType.bIsUObjectWrapper=False,PinType.bSerializeAsSinglePrecisionFloat=False${defaultValueFragment},PersistentGuid=00000000000000000000000000000000${hiddenFragment},bNotConnectable=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)`
}

function createValuePin(
  variable: Pick<ExtractedVariable, 'name' | 'type' | 'defaultValue' | 'containerType'>,
  direction: 'EGPD_Input' | 'EGPD_Output'
): string {
  const pinType = getPinTypeDescriptor(variable)
  return createTypedPin({
    name: variable.name,
    direction,
    category: pinType.category,
    subCategory: pinType.subCategory,
    subCategoryObject: pinType.subCategoryObject,
    containerType: pinType.containerType,
    defaultValue: variable.defaultValue,
    isReference: pinType.isReference
  })
}

function createSelfPin(): string {
  return createTypedPin({
    name: 'self',
    direction: 'EGPD_Input',
    category: 'object',
    subCategory: 'self',
    subCategoryObject: 'None',
    friendlyName: 'NSLOCTEXT("K2Node", "Target", "Target")',
    tooltip: 'Target\\nSelf object reference'
  })
}

function createVariableSelfPin(): string {
  return createTypedPin({
    name: 'self',
    direction: 'EGPD_Input',
    category: 'object',
    subCategory: '',
    subCategoryObject: 'None',
    friendlyName: 'NSLOCTEXT("K2Node", "Target", "Target")',
    hidden: true
  })
}

function createVariableOutputPin(
  variable: Pick<ExtractedVariable, 'type' | 'defaultValue' | 'containerType'>
): string {
  const pinType = getPinTypeDescriptor(variable)
  return createTypedPin({
    name: 'Output_Get',
    direction: 'EGPD_Output',
    category: pinType.category,
    subCategory: pinType.subCategory,
    subCategoryObject: pinType.subCategoryObject,
    containerType: pinType.containerType,
    defaultValue: variable.defaultValue,
    tooltip: 'Gets the value of the variable and can be used instead of a separate Get node.'
  })
}

export function createVariableNodeClipboardText(
  variable: ExtractedVariable,
  accessType: VariableNodeAccessType
): string {
  const objectClass =
    accessType === 'set'
      ? '/Script/BlueprintGraph.K2Node_VariableSet'
      : '/Script/BlueprintGraph.K2Node_VariableGet'
  const objectName = createObjectName(
    accessType === 'set' ? 'K2Node_VariableSet' : 'K2Node_VariableGet'
  )
  const lines = [
    `Begin Object Class="${objectClass}" Name="${objectName}"`,
    `   VariableReference=(MemberName="${escapeBlueprintString(variable.name)}",bSelfContext=True)`,
    '   NodePosX=0',
    '   NodePosY=0',
    `   NodeGuid=${createGuid()}`
  ]

  if (accessType === 'set') {
    lines.push(createExecPin('execute', 'EGPD_Input'))
    lines.push(createExecPin('then', 'EGPD_Output'))
    lines.push(createValuePin(variable, 'EGPD_Input'))
    lines.push(createVariableSelfPin())
    lines.push(createVariableOutputPin(variable))
  } else {
    lines.push(createValuePin(variable, 'EGPD_Output'))
  }

  lines.push('End Object')
  return lines.join('\n')
}

function createFunctionValuePin(
  param: FunctionParam,
  direction: 'EGPD_Input' | 'EGPD_Output'
): string {
  return createValuePin(
    {
      name: param.name,
      type: param.type,
      defaultValue: param.defaultValue
    },
    direction
  )
}

export function createFunctionNodeClipboardText(options: {
  name: string
  inputs: FunctionParam[]
  outputs: FunctionParam[]
  isPure: boolean
  memberGuid?: string
}): string {
  const objectName = createObjectName('K2Node_CallFunction')
  const memberGuidFragment = options.memberGuid ? `,MemberGuid=${options.memberGuid}` : ''
  const lines = [
    'Begin Object Class="/Script/BlueprintGraph.K2Node_CallFunction" Name="' + objectName + '"',
    `   FunctionReference=(MemberName="${escapeBlueprintString(options.name)}"${memberGuidFragment},bSelfContext=True)`,
    '   NodePosX=0',
    '   NodePosY=0',
    `   NodeGuid=${createGuid()}`
  ]

  if (options.isPure) {
    lines.push('   bIsPureFunc=True')
  } else {
    lines.push(createExecPin('execute', 'EGPD_Input'))
    lines.push(createExecPin('then', 'EGPD_Output'))
  }

  lines.push(createSelfPin())

  for (const input of options.inputs) {
    lines.push(createFunctionValuePin(input, 'EGPD_Input'))
  }

  for (const output of options.outputs) {
    lines.push(createFunctionValuePin(output, 'EGPD_Output'))
  }

  lines.push('End Object')
  return lines.join('\n')
}
