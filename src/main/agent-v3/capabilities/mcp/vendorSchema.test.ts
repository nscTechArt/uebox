import { describe, expect, it } from 'vitest'

import { toVendorSafeSchema } from './vendorSchema'

const json = (value: unknown): string => JSON.stringify(value)

describe('toVendorSafeSchema', () => {
  it('普通 schema 原样保留', () => {
    const input = {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path']
    }
    expect(toVendorSafeSchema(input)).toEqual(input)
  })

  describe('$ref 内联', () => {
    // 厂商不解引用，留着 $ref 会让**整个请求**被拒，所有工具一起失效
    it('把 $defs 里的定义内联进来', () => {
      const out = toVendorSafeSchema({
        type: 'object',
        $defs: { filter: { type: 'object', properties: { field: { type: 'string' } } } },
        properties: { f: { $ref: '#/$defs/filter' } }
      })

      expect(json(out)).not.toContain('$ref')
      expect(json(out)).not.toContain('$defs')
      expect(out.properties).toEqual({
        f: { type: 'object', properties: { field: { type: 'string' } } }
      })
    })

    it('数组元素里的 $ref 一样内联', () => {
      const out = toVendorSafeSchema({
        type: 'object',
        $defs: { item: { type: 'string' } },
        properties: { list: { type: 'array', items: { $ref: '#/$defs/item' } } }
      })
      expect(out.properties).toEqual({
        list: { type: 'array', items: { type: 'string' } }
      })
    })

    it('老写法 definitions 也认', () => {
      const out = toVendorSafeSchema({
        type: 'object',
        definitions: { x: { type: 'number' } },
        properties: { a: { $ref: '#/definitions/x' } }
      })
      expect(out.properties).toEqual({ a: { type: 'number' } })
    })

    it('JSON Pointer 的 ~1 / ~0 转义', () => {
      const out = toVendorSafeSchema({
        type: 'object',
        $defs: { 'a/b~c': { type: 'boolean' } },
        properties: { flag: { $ref: '#/$defs/a~1b~0c' } }
      })
      expect(out.properties).toEqual({ flag: { type: 'boolean' } })
    })

    // 宁可降级成"任意值"，也不能把解不开的 $ref 留下去
    it('解不开的 $ref 降级成任意值，而不是保留', () => {
      const out = toVendorSafeSchema({
        type: 'object',
        properties: { a: { $ref: '#/$defs/missing' }, b: { $ref: 'https://example.com/s.json' } }
      })
      expect(json(out)).not.toContain('$ref')
      expect(out.properties).toEqual({ a: {}, b: {} })
    })

    it('自引用成环时不死循环', () => {
      const out = toVendorSafeSchema({
        type: 'object',
        $defs: { node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } } },
        properties: { root: { $ref: '#/$defs/node' } }
      })
      expect(json(out)).not.toContain('$ref')
    })
  })

  describe('oneOf / anyOf', () => {
    it('各分支同类型时保留该类型', () => {
      const out = toVendorSafeSchema({
        type: 'object',
        properties: { n: { oneOf: [{ type: 'string' }, { type: 'string', maxLength: 5 }] } }
      })
      expect(out.properties).toEqual({ n: { type: 'string' } })
    })

    /**
     * 类型不一致时降级成任意值，而不是猜一个。
     *
     * 猜具体类型会让模型填不出对方要的形状 —— 那是比"放宽"更糟的失败：
     * 放宽了对方 server 会自己校验并报错，猜错了模型根本没机会填对。
     */
    it('类型不一致时降级成任意值，并保住描述', () => {
      const out = toVendorSafeSchema({
        type: 'object',
        properties: {
          target: {
            description: '收件人',
            oneOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'number' } } }]
          }
        }
      })
      expect(out.properties).toEqual({ target: { description: '收件人' } })
      expect(json(out)).not.toContain('oneOf')
    })

    it('都是 object 时属性取并集、required 取交集', () => {
      const out = toVendorSafeSchema({
        type: 'object',
        properties: {
          x: {
            anyOf: [
              { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'c'] },
              { type: 'object', properties: { b: { type: 'number' } }, required: ['a'] }
            ]
          }
        }
      })
      // 只有各分支都要求的才是真必填
      expect(out.properties).toEqual({
        x: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'number' } },
          required: ['a']
        }
      })
    })
  })

  describe('allOf', () => {
    it('浅合并各分支的属性和必填项', () => {
      const out = toVendorSafeSchema({
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] }
        ]
      })
      expect(out).toEqual({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        required: ['a', 'b']
      })
    })

    it('allOf 里的 $ref 先内联再合并', () => {
      const out = toVendorSafeSchema({
        $defs: { base: { type: 'object', properties: { id: { type: 'string' } } } },
        allOf: [{ $ref: '#/$defs/base' }, { type: 'object', properties: { n: { type: 'number' } } }]
      })
      expect(out.properties).toEqual({ id: { type: 'string' }, n: { type: 'number' } })
    })
  })

  describe('顶层形态', () => {
    // 厂商的工具参数只接受对象
    it('顶层不是 object 时补成空对象', () => {
      expect(toVendorSafeSchema({ type: 'string' })).toEqual({ type: 'object', properties: {} })
    })

    it('没给 properties 时补一个空的', () => {
      expect(toVendorSafeSchema({ type: 'object' })).toEqual({ type: 'object', properties: {} })
    })

    it.each([undefined, null, 'nope', 42, []])('不是对象的输入也要给出可用 schema：%s', (input) => {
      expect(toVendorSafeSchema(input)).toEqual({ type: 'object', properties: {} })
    })

    it('$schema / $id 这类元信息一并去掉', () => {
      const out = toVendorSafeSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'https://example.com/x',
        type: 'object',
        properties: {}
      })
      expect(out).toEqual({ type: 'object', properties: {} })
    })
  })

  it('enum、description、default 这些厂商认的关键字要保留', () => {
    const out = toVendorSafeSchema({
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['eq', 'gt'], description: '比较符', default: 'eq' }
      },
      required: ['op']
    })
    expect(out.properties).toEqual({
      op: { type: 'string', enum: ['eq', 'gt'], description: '比较符', default: 'eq' }
    })
    expect(out.required).toEqual(['op'])
  })

  it('深层嵌套逐层处理，不只处理第一层', () => {
    const out = toVendorSafeSchema({
      type: 'object',
      $defs: { leaf: { type: 'boolean' } },
      properties: {
        a: {
          type: 'object',
          properties: {
            b: {
              type: 'array',
              items: { type: 'object', properties: { c: { $ref: '#/$defs/leaf' } } }
            }
          }
        }
      }
    })
    expect(json(out)).not.toContain('$ref')
    expect(json(out)).toContain('boolean')
  })

  // 恶意或写坏的 server 不该把主进程撑爆
  it('超深嵌套不抛异常', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 200; i++) {
      deep = { type: 'object', properties: { next: deep } }
    }
    expect(() => toVendorSafeSchema(deep)).not.toThrow()
  })
})
