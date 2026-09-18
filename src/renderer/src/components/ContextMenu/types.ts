export interface MenuItem {
  key?: string
  label?: string
  icon?: any
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  className?: string
  backgroundColor?: string
  textColor?: string
  type?: 'item' | 'divider'
}
