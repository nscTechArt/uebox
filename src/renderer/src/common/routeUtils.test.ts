import { describe, expect, it } from 'vitest'
import { isReactive, ref } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import {
  findMenuTargetByKey,
  generateMenuFromRoutes,
  getOpenMenuKeys,
  getSelectedMenuKeys,
  type MenuItem
} from './routeUtils'

describe('routeUtils', () => {
  it('keeps icons raw in reactive menus, including nested items and regenerated labels', () => {
    const routes = [
      {
        path: '/',
        children: [
          {
            path: '/material-library',
            name: 'MaterialLibrary',
            meta: { title: 'menu.materialLib' },
            children: [{ path: '', name: 'MaterialGallery', meta: { title: 'menu.materialLib' } }]
          },
          { path: '/asset-management', name: 'Assets', meta: { title: 'menu.assets' } }
        ]
      }
    ] as unknown as RouteRecordRaw[]
    const menu = ref<MenuItem[]>([])

    for (const locale of ['zh-CN', 'en-US']) {
      const generated = generateMenuFromRoutes(routes, (key) => `${locale}:${key}`)
      menu.value = generated
      expect(isReactive(menu.value[0])).toBe(true)
      const items = [menu.value[0], menu.value[0].children![0], menu.value[1]]
      const originals = [generated[0], generated[0].children![0], generated[1]]
      items.forEach((item, index) => {
        expect(isReactive(item.icon)).toBe(false)
        expect(item.icon).toBe(originals[index].icon)
        expect(item.label).toBe(`${locale}:${index === 2 ? 'menu.assets' : 'menu.materialLib'}`)
      })
    }
  })

  it('normalizes generated child paths without duplicate trailing separators', () => {
    const routes = [
      {
        path: '/',
        children: [
          {
            path: '/material-library',
            name: 'MaterialLibrary',
            meta: {
              title: 'menu.materialLib',
              isShowInMenu: true
            },
            children: [
              {
                path: '',
                name: 'MaterialGallery',
                meta: {
                  title: 'menu.materialLib',
                  isShowInMenu: true
                }
              }
            ]
          }
        ]
      }
    ] as unknown as RouteRecordRaw[]

    const menu = generateMenuFromRoutes(routes, (key) => key)

    expect(menu[0]?.children?.[0]?.path).toBe('/material-library')
  })

  it('keeps top-level libraries selected on nested detail paths', () => {
    const menuItems: MenuItem[] = [
      {
        key: 'MaterialLibrary',
        icon: null,
        label: 'Material Library',
        path: '/material-library'
      },
      {
        key: 'BlueprintLibrary',
        icon: null,
        label: 'Blueprint Library',
        path: '/blueprint-library'
      }
    ]

    expect(getSelectedMenuKeys('/material-library/material-123', menuItems)).toEqual([
      'MaterialLibrary'
    ])
    expect(getSelectedMenuKeys('/blueprint-library/blueprint-123', menuItems)).toEqual([
      'BlueprintLibrary'
    ])
  })

  it('matches dynamic child menu routes when computing selected and open keys', () => {
    const menuItems: MenuItem[] = [
      {
        key: 'Workspace',
        icon: null,
        label: 'Workspace',
        path: '/workspace',
        children: [
          {
            key: 'WorkspaceProjectDetail',
            icon: null,
            label: 'Project Detail',
            path: '/workspace/projects/:id'
          }
        ]
      }
    ]

    expect(getSelectedMenuKeys('/workspace/projects/project-a', menuItems)).toEqual([
      'WorkspaceProjectDetail'
    ])
    expect(getOpenMenuKeys('/workspace/projects/project-a', menuItems)).toEqual(['Workspace'])
  })

  it('resolves the canonical navigation target from a menu key', () => {
    const menuItems: MenuItem[] = [
      {
        key: 'Notebooks',
        icon: null,
        label: 'Notebooks',
        path: '/notebooks'
      },
      {
        key: 'Workspace',
        icon: null,
        label: 'Workspace',
        path: '/workspace',
        children: [
          {
            key: 'WorkspaceProjects',
            icon: null,
            label: 'Projects',
            path: '/workspace/projects'
          }
        ]
      }
    ]

    expect(findMenuTargetByKey(menuItems, 'Notebooks')).toBe('/notebooks')
    expect(findMenuTargetByKey(menuItems, 'WorkspaceProjects')).toBe('/workspace/projects')
    expect(findMenuTargetByKey(menuItems, 'Missing')).toBeNull()
  })
})
