import Database from 'better-sqlite3'

export interface Shortcut {
  id?: number
  action_key: string
  accelerator: string
  type: 'global' | 'local'
  enabled: boolean
  description: string
  is_locked: boolean
  updated_at?: string
}

interface ShortcutRow {
  id: number
  action_key: string
  accelerator: string
  type: 'global' | 'local'
  enabled: number
  description: string
  is_locked: number
  updated_at: string
}

const TABLE_NAME = 'app_shortcuts'

/**
 * 内置快捷键的默认行。
 *
 * ## 这里的 `description` 不是显示文案
 *
 * 设置页显示的是 `profile.shortcuts.action.<action_key>`，查得到就用它，
 * 查不到才退回这个字段（`ProfileShortcuts.vue`）。所以这几句中文是**兜底**，
 * 正常情况下一个字都不会出现在界面上。
 *
 * 兜底不该是中文，但也不该在这里翻：这些行会**落进数据库**，一旦写进去就不再
 * 更新，翻了等于把首次启动时的语言永久冻在库里。正确的做法是每个 action_key
 * 在语言包里都有一条 —— 漏了才会掉到这里来。
 *
 * 真机上就漏过一条：`app.screenshot_mode` 在语言包里没有，于是英文用户的
 * 快捷键表里孤零零一行中文。补语言包即可，这里保持原样。
 */
const DEFAULT_SHORTCUTS: Shortcut[] = [
  {
    action_key: 'app.toggle_main_window',
    accelerator: 'Alt+`',
    type: 'global',
    description: '呼出/隐藏主界面',
    enabled: true,
    is_locked: false
  },
  {
    action_key: 'app.toggle_window',
    accelerator: 'CommandOrControl+Shift+Space',
    type: 'global',
    description: '呼出/隐藏小窗口',
    enabled: true,
    is_locked: false
  },
  {
    action_key: 'app.reload',
    accelerator: 'CommandOrControl+Shift+R',
    type: 'local',
    description: '刷新当前页面',
    enabled: true,
    is_locked: false
  },
  {
    action_key: 'app.screenshot_mode',
    accelerator: 'CommandOrControl+Shift+F12',
    type: 'global',
    description: '进入截图模式',
    enabled: true,
    is_locked: false
  },
  /*
   * 打断语音助手。**默认留空、默认不启用** —— 由用户自己在设置里配。
   *
   * 语音这一版是半双工：它说话期间麦克风是闭着的（外放时音箱贴着麦克风，
   * 靠比响度分不开回声和人声），所以打断只能手动。球体点一下也能打断，
   * 快捷键是给「手在键盘上、或者戴着耳机没看屏幕」的场景准备的。
   *
   * 不预设按键是因为这是个全局热键，占了哪个组合都可能和用户已经在用的
   * 别的软件撞上，而撞上的表现是那个软件的功能默默失灵。
   */
  {
    action_key: 'voice.interrupt',
    accelerator: '',
    type: 'global',
    description: '打断语音助手',
    enabled: false,
    is_locked: false
  }
]

export const initShortcutModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_key TEXT NOT NULL UNIQUE,
      accelerator TEXT,
      type TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      description TEXT,
      is_locked BOOLEAN DEFAULT FALSE,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `
  db.exec(createTableSQL)

  // Sync missing shortcuts from DEFAULT_SHORTCUTS
  const existingKeys = (
    db.prepare(`SELECT action_key FROM ${TABLE_NAME}`).all() as { action_key: string }[]
  ).map((row) => row.action_key)

  console.log('[Shortcut] 数据库现有快捷键:', existingKeys)
  console.log(
    '[Shortcut] 默认快捷键列表:',
    DEFAULT_SHORTCUTS.map((s) => s.action_key)
  )

  const missingShortcuts = DEFAULT_SHORTCUTS.filter(
    (shortcut) => !existingKeys.includes(shortcut.action_key)
  )

  if (missingShortcuts.length > 0) {
    const insert = db.prepare(`
      INSERT INTO ${TABLE_NAME} (action_key, accelerator, type, enabled, description, is_locked)
      VALUES (@action_key, @accelerator, @type, @enabled, @description, @is_locked)
    `)
    const insertMany = db.transaction((shortcuts: Shortcut[]) => {
      for (const shortcut of shortcuts) {
        insert.run({
          ...shortcut,
          enabled: shortcut.enabled ? 1 : 0,
          is_locked: shortcut.is_locked ? 1 : 0
        })
      }
    })
    insertMany(missingShortcuts)
    console.log(
      `Synced ${missingShortcuts.length} new shortcut(s):`,
      missingShortcuts.map((s) => s.action_key)
    )
  }
}

/**
 * 恢复所有快捷键为默认值
 * 清空表并重新插入默认快捷键
 */
export const resetAllShortcuts = (db: Database.Database): void => {
  // 清空表
  db.exec(`DELETE FROM ${TABLE_NAME}`)

  // 重新插入默认快捷键
  const insert = db.prepare(`
    INSERT INTO ${TABLE_NAME} (action_key, accelerator, type, enabled, description, is_locked)
    VALUES (@action_key, @accelerator, @type, @enabled, @description, @is_locked)
  `)
  const insertMany = db.transaction((shortcuts: Shortcut[]) => {
    for (const shortcut of shortcuts) {
      insert.run({
        ...shortcut,
        enabled: shortcut.enabled ? 1 : 0,
        is_locked: shortcut.is_locked ? 1 : 0
      })
    }
  })
  insertMany(DEFAULT_SHORTCUTS)
  console.log('[Shortcut] 已恢复默认快捷键')
}

export const getAllShortcuts = (db: Database.Database): Shortcut[] => {
  const rows = db.prepare(`SELECT * FROM ${TABLE_NAME}`).all() as ShortcutRow[]
  const shortcuts = rows.map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    is_locked: Boolean(row.is_locked)
  }))

  // Sort according to DEFAULT_SHORTCUTS order
  const orderMap = new Map(DEFAULT_SHORTCUTS.map((s, i) => [s.action_key, i]))
  return shortcuts.sort((a, b) => {
    const orderA = orderMap.get(a.action_key) ?? 999
    const orderB = orderMap.get(b.action_key) ?? 999
    return orderA - orderB
  })
}

export const updateShortcut = (
  db: Database.Database,
  actionKey: string,
  updates: Partial<Shortcut>
): boolean => {
  const fields: string[] = []
  const values: (string | number)[] = []

  if (updates.accelerator !== undefined) {
    fields.push('accelerator = ?')
    values.push(updates.accelerator)
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?')
    values.push(updates.enabled ? 1 : 0)
  }

  if (fields.length === 0) return false

  fields.push("updated_at = datetime('now', 'localtime')")
  values.push(actionKey)

  const stmt = db.prepare(`UPDATE ${TABLE_NAME} SET ${fields.join(', ')} WHERE action_key = ?`)
  return stmt.run(...values).changes > 0
}

export const getShortcutByAction = (
  db: Database.Database,
  actionKey: string
): Shortcut | undefined => {
  const row = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE action_key = ?`).get(actionKey) as
    | ShortcutRow
    | undefined
  if (!row) return undefined
  return {
    ...row,
    enabled: Boolean(row.enabled),
    is_locked: Boolean(row.is_locked)
  }
}
