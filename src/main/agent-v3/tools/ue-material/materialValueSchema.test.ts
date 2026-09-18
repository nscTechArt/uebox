import { describe, expect, it } from 'vitest'
import {
  MaterialParamListSchema,
  MaterialValueSchema,
  materialParamEntriesToRecord
} from './materialValueSchema'

describe('materialValueSchema', () => {
  it('accepts supported material value variants', () => {
    expect(MaterialValueSchema.parse(0.5)).toBe(0.5)
    expect(MaterialValueSchema.parse('/Game/Textures/T_Grass_D')).toBe('/Game/Textures/T_Grass_D')
    expect(MaterialValueSchema.parse({ r: 1, g: 0.5, b: 0.25 })).toEqual({
      r: 1,
      g: 0.5,
      b: 0.25
    })
    expect(MaterialValueSchema.parse({ u_tiling: 2, v_tiling: 4 })).toEqual({
      u_tiling: 2,
      v_tiling: 4
    })
  })

  it('converts parameter entry arrays into RPC-friendly records', () => {
    const parsed = MaterialParamListSchema.parse([
      { name: 'Roughness', value: 0.35 },
      { name: 'Tint', value: { r: 0.8, g: 0.7, b: 0.6, a: 1 } }
    ])

    expect(materialParamEntriesToRecord(parsed)).toEqual({
      Roughness: 0.35,
      Tint: { r: 0.8, g: 0.7, b: 0.6, a: 1 }
    })
  })
})
