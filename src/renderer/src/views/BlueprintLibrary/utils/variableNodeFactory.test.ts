import { describe, expect, it } from 'vitest'
import {
  createCommentNodeClipboardText,
  createFunctionNodeClipboardText,
  createVariableNodeClipboardText
} from './variableNodeFactory'

describe('createVariableNodeClipboardText', () => {
  it('creates a variable get node with an output pin for primitive variables', () => {
    const text = createVariableNodeClipboardText(
      {
        id: 'var-command',
        name: 'Command',
        type: 'String'
      },
      'get'
    )

    expect(text).toContain('Class="/Script/BlueprintGraph.K2Node_VariableGet"')
    expect(text).toContain('VariableReference=(MemberName="Command",bSelfContext=True)')
    expect(text).toContain('PinName="Command",Direction="EGPD_Output"')
    expect(text).toContain('PinType.PinCategory="string"')
  })

  it('creates a variable set node with exec pins and preserves typed defaults', () => {
    const text = createVariableNodeClipboardText(
      {
        id: 'var-value',
        name: 'Value',
        type: 'Double',
        defaultValue: '1.5'
      },
      'set'
    )

    expect(text).toContain('Class="/Script/BlueprintGraph.K2Node_VariableSet"')
    expect(text).toContain('PinName="execute"')
    expect(text).toContain('PinName="then",Direction="EGPD_Output"')
    expect(text).toContain('PinName="Value"')
    expect(text).toContain('PinType.PinCategory="real"')
    expect(text).toContain('PinType.PinSubCategory="double"')
    expect(text).toContain('DefaultValue="1.5"')
    expect(text).toContain('PinName="self"')
    expect(text).toContain('PinFriendlyName=NSLOCTEXT("K2Node", "Target", "Target")')
    expect(text).toContain('PinName="Output_Get"')
    expect(text).toContain('Direction="EGPD_Output"')
    expect(text).toContain('bHidden=True')
  })

  it('creates a function call node with purity and typed pins', () => {
    const text = createFunctionNodeClipboardText({
      name: 'ComputeDamage',
      inputs: [{ name: 'BaseDamage', type: 'Float', defaultValue: '10.0' }],
      outputs: [{ name: 'FinalDamage', type: 'Float' }],
      isPure: true
    })

    expect(text).toContain('Class="/Script/BlueprintGraph.K2Node_CallFunction"')
    expect(text).toContain('FunctionReference=(MemberName="ComputeDamage",bSelfContext=True)')
    expect(text).toContain('bIsPureFunc=True')
    expect(text).toContain('PinName="self"')
    expect(text).toContain('PinFriendlyName=NSLOCTEXT("K2Node", "Target", "Target")')
    expect(text).toContain('PinName="BaseDamage"')
    expect(text).toContain('DefaultValue="10.0"')
    expect(text).toContain('PinName="FinalDamage",Direction="EGPD_Output"')
  })
})

describe('createCommentNodeClipboardText', () => {
  it('creates a UE comment node at the requested graph position', () => {
    const text = createCommentNodeClipboardText({
      nodePosX: 415.7,
      nodePosY: 288.2
    })

    expect(text).toContain('Class=/Script/UnrealEd.EdGraphNode_Comment')
    expect(text).toContain('Name="EdGraphNode_Comment_')
    expect(text).toContain('CommentColor=(R=0.150000,G=0.150000,B=0.150000,A=0.500000)')
    expect(text).toContain('NodePosX=416')
    expect(text).toContain('NodePosY=288')
    expect(text).toContain('bCommentBubblePinned=False')
    expect(text).toContain('bCommentBubbleVisible=False')
    expect(text).toContain('NodeComment="\u6ce8\u91ca"')
    expect(text).toMatch(/NodeGuid=[0-9A-F]{32}/)
  })
})
