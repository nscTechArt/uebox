import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AppPageSkeleton from './AppPageSkeleton.vue'

describe('AppPageSkeleton', () => {
  it('announces loading without exposing decorative cards to screen readers', () => {
    const wrapper = mount(AppPageSkeleton, { props: { title: 'Library' } })
    expect(wrapper.get('[role="status"]').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('h2').text()).toBe('Library')
    expect(wrapper.get('.skeleton-items').attributes('aria-hidden')).toBe('true')
    expect(wrapper.findAll('.skeleton-item')).toHaveLength(12)
  })

  it('supports a compact list placeholder without an extra page header', () => {
    const wrapper = mount(AppPageSkeleton, { props: { layout: 'list', count: 3 } })
    expect(wrapper.find('header').exists()).toBe(false)
    expect(wrapper.get('.skeleton-items').classes()).toContain('list')
    expect(wrapper.findAll('.skeleton-item')).toHaveLength(3)
  })
})
