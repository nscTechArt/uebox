/** Always stop a probe stream, including one that arrives after consent timed out. */
export async function probeScreenCapture(
  acquire: () => Promise<MediaStream>,
  timeoutMs = 1500
): Promise<boolean> {
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stream: MediaStream | undefined
  try {
    const pending = acquire().then((value) => {
      if (expired) value.getTracks().forEach((track) => track.stop())
      else stream = value
      return value
    })
    return await Promise.race([
      // 必须自己吃掉失败：超时先赢下 race 之后，这条分支再抛就没人接了
      // —— 用户在同意框上磨蹭超过 timeoutMs 再点「拒绝」正好走到这里。
      pending.then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          expired = true
          resolve(false)
        }, timeoutMs)
      })
    ])
  } catch {
    return false
  } finally {
    expired = true
    if (timer) clearTimeout(timer)
    stream?.getTracks().forEach((track) => track.stop())
  }
}
