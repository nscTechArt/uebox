/** 编辑器崩溃的系统通知文案。纯函数，按界面语言出两套 */

import type { EditorCrash } from './watch'

export function crashNotice(
  crash: EditorCrash,
  language: 'zh-CN' | 'en-US'
): { title: string; body: string } {
  const name = crash.editor.projectName
  const zh = language === 'zh-CN'
  const title = zh ? `${name} 的编辑器崩溃了` : `${name}: Unreal Editor crashed`

  let body: string
  switch (crash.relaunch) {
    case 'relaunched':
      body = zh ? '已自动重新打开。' : 'Reopened automatically.'
      break
    case 'disabled':
      body = zh
        ? '自动重开已关闭，需要手动打开工程。'
        : 'Auto-reopen is off. Open the project manually.'
      break
    case 'crash_loop':
      body = zh
        ? '5 分钟内第二次崩溃，这次没有自动重开。'
        : 'Second crash within 5 minutes, so it was not reopened.'
      break
    case 'already_running':
      body = zh ? '编辑器已经重新打开。' : 'The editor is already running again.'
      break
    case 'no_uproject':
      body = zh
        ? '找不到 .uproject，需要手动打开工程。'
        : 'No .uproject found. Open the project manually.'
      break
    case 'failed':
      body = zh
        ? `重新打开失败：${crash.relaunchError ?? '原因未知'}`
        : `Could not reopen: ${crash.relaunchError ?? 'unknown error'}`
      break
  }

  if (crash.restore) {
    body += zh
      ? `未保存的自动存档已备份到 ${crash.restore.backupDir}`
      : ` Unsaved autosaves were backed up to ${crash.restore.backupDir}`
  }
  return { title, body }
}
