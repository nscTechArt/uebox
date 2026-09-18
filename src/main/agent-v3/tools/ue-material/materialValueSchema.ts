import { z } from 'zod'

export const MaterialColorValueSchema = z.object({
  r: z.number(),
  g: z.number(),
  b: z.number(),
  a: z.number().optional()
})

export const MaterialVectorValueSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number().optional(),
  w: z.number().optional()
})

export const MaterialUvValueSchema = z
  .object({
    u_tiling: z.number().optional(),
    v_tiling: z.number().optional(),
    u_offset: z.number().optional(),
    v_offset: z.number().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one UV field is required'
  })

export const MaterialNumericArrayValueSchema = z.array(z.number()).min(2).max(4)

export const MaterialValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  MaterialColorValueSchema,
  MaterialVectorValueSchema,
  MaterialUvValueSchema,
  MaterialNumericArrayValueSchema
])

export const MaterialParamEntrySchema = z.object({
  name: z.string().min(1).describe('Material parameter name'),
  value: MaterialValueSchema.describe('Material parameter value')
})

export const MaterialParamListSchema = z
  .array(MaterialParamEntrySchema)
  .min(1)
  .describe('List of material parameter updates')

export type MaterialValue = z.infer<typeof MaterialValueSchema>
export type MaterialParamEntry = z.infer<typeof MaterialParamEntrySchema>

export function materialParamEntriesToRecord(
  entries: MaterialParamEntry[]
): Record<string, MaterialValue> {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]))
}
