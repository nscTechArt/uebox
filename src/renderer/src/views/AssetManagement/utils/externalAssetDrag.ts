/** Return true for Alt drags, including rejected ones, so they never enter internal move logic. */
export function handleExternalAssetDrag(
  event: Pick<DragEvent, 'altKey' | 'preventDefault'>,
  resolveFile: () => string | null,
  startDrag: (filePath: string) => Promise<void>,
  onError: () => void
): boolean {
  if (!event.altKey) return false
  event.preventDefault()
  const filePath = resolveFile()
  if (!filePath) {
    onError()
    return true
  }
  void startDrag(filePath).catch(onError)
  return true
}
