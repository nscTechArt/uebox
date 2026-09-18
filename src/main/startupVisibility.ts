export const START_HIDDEN_ARG = '--hidden'

const PROCESS_START_ARGS_ARG = '--process-start-args'

interface StartupVisibilityOptions {
  argv?: readonly string[]
  wasOpenedAtLogin?: boolean
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed

  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

function tokenListHasHiddenArg(value: string): boolean {
  return stripWrappingQuotes(value)
    .split(/\s+/)
    .some((token) => stripWrappingQuotes(token) === START_HIDDEN_ARG)
}

export function hasStartHiddenArg(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = stripWrappingQuotes(argv[index])

    if (arg === START_HIDDEN_ARG) {
      return true
    }

    if (arg.startsWith(`${PROCESS_START_ARGS_ARG}=`)) {
      const processStartArgs = arg.slice(PROCESS_START_ARGS_ARG.length + 1)
      if (tokenListHasHiddenArg(processStartArgs)) {
        return true
      }
    }

    if (arg === PROCESS_START_ARGS_ARG && argv[index + 1]) {
      if (tokenListHasHiddenArg(argv[index + 1])) {
        return true
      }
    }
  }

  return false
}

export function shouldStartHiddenAtLaunch({
  argv = process.argv,
  wasOpenedAtLogin = false
}: StartupVisibilityOptions = {}): boolean {
  return wasOpenedAtLogin || hasStartHiddenArg(argv)
}
