import { expect, it } from 'vitest'
import { acceleratorModifiers, acceleratorKeyLabels } from './accelerator'

it('distinguishes Command, Control, and their combination on Mac', () => {
  expect(acceleratorModifiers({ ctrlKey: true }, 'darwin')).toEqual(['Control'])
  expect(acceleratorModifiers({ metaKey: true }, 'darwin')).toEqual(['CommandOrControl'])
  expect(acceleratorModifiers({ ctrlKey: true, metaKey: true, shiftKey: true }, 'darwin')).toEqual([
    'CommandOrControl',
    'Control',
    'Shift'
  ])
})

it('retains Windows modifier normalization', () => {
  expect(acceleratorModifiers({ ctrlKey: true, altKey: true, shiftKey: true }, 'win32')).toEqual([
    'CommandOrControl',
    'Alt',
    'Shift'
  ])
  expect(acceleratorModifiers({ metaKey: true }, 'win32')).toEqual(['CommandOrControl'])
})

it('displays the actual Mac modifiers without relabeling Control as Command', () => {
  expect(acceleratorKeyLabels('CommandOrControl+Control+Alt+Shift+K', 'darwin')).toEqual([
    '⌘',
    '⌃',
    '⌥',
    '⇧',
    'K'
  ])
  expect(acceleratorKeyLabels('CommandOrControl+Shift+K', 'win32')).toEqual(['Ctrl', 'Shift', 'K'])
  expect(acceleratorKeyLabels('Control+Space', 'darwin')).toEqual(['⌃', 'Space'])
})
