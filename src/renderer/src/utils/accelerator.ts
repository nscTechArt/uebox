interface ModifierInput {
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/** Mac Control is a separate key; CommandOrControl means Command there. */
export function acceleratorModifiers(event: ModifierInput, platform: string): string[] {
  const modifiers: string[] = []
  if (platform === 'darwin') {
    if (event.metaKey) modifiers.push('CommandOrControl')
    if (event.ctrlKey) modifiers.push('Control')
  } else if (event.ctrlKey || event.metaKey) {
    modifiers.push('CommandOrControl')
  }
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  return modifiers
}

export function acceleratorKeyLabels(accelerator: string, platform: string): string[] {
  const mac = platform === 'darwin'
  const labels: Record<string, string> = {
    CommandOrControl: mac ? '⌘' : 'Ctrl',
    CmdOrCtrl: mac ? '⌘' : 'Ctrl',
    Command: mac ? '⌘' : 'Cmd',
    Cmd: mac ? '⌘' : 'Cmd',
    Control: mac ? '⌃' : 'Ctrl',
    Ctrl: mac ? '⌃' : 'Ctrl',
    Alt: mac ? '⌥' : 'Alt',
    Shift: mac ? '⇧' : 'Shift'
  }
  return accelerator.split('+').map((key) => labels[key] ?? key)
}
