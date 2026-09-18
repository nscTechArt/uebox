type Listener = (...args: unknown[]) => void

type StreamState = {
  listeners?: Map<string, Set<Listener>>
}

function getListeners(stream: StreamState): Map<string, Set<Listener>> {
  return (stream.listeners ??= new Map())
}

/** 浏览器端只需满足 simple-mind-map 内置 SAX 解析器的事件接口。 */
export function Stream(this: StreamState): void {
  getListeners(this)
}

Stream.prototype.on = function (this: StreamState, event: string, listener: Listener): StreamState {
  const listeners = getListeners(this)
  const eventListeners = listeners.get(event) ?? new Set<Listener>()
  eventListeners.add(listener)
  listeners.set(event, eventListeners)
  return this
}

Stream.prototype.emit = function (this: StreamState, event: string, ...args: unknown[]): boolean {
  const eventListeners = getListeners(this).get(event)
  if (!eventListeners) return false
  for (const listener of [...eventListeners]) listener(...args)
  return true
}

Stream.prototype.removeAllListeners = function (this: StreamState, event?: string): StreamState {
  if (event) getListeners(this).delete(event)
  else getListeners(this).clear()
  return this
}
