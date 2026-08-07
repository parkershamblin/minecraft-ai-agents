import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SkillSchemaStub } from '../src/skills/types.ts'

// docs/architecture/10-skill-tool-schema.md R1 says a stub's params "must be
// byte-equal to the $defs entry the v-next PR proposes" and that "divergence
// is a CI failure, same as generated-type drift". Until 2026-08-07 no such CI
// existed — the doc described a gate that was never built, so every stub was
// unchecked and R2/R3 compliance was a promise. This file is that gate.
//
// It enforces what is checkable TODAY (the strict-safe shape rules every
// contract $defs already obeys, and failure-code reachability), and
// self-activates the byte-equality clause the moment a stub name becomes a
// contract verb — which is exactly when R1 starts to bite.

const libDir = fileURLToPath(new URL('../src/skills/library/', import.meta.url))

const actionRequested = JSON.parse(
  readFileSync(
    new URL('../../../packages/events/schemas/commands/ActionRequested.v1.schema.json', import.meta.url),
    'utf8',
  ),
)
const actionFailedCodes: string[] = JSON.parse(
  readFileSync(
    new URL('../../../packages/events/schemas/world/ActionFailed.v1.schema.json', import.meta.url),
    'utf8',
  ),
).properties.errorCode.enum

const stubs: Array<{ file: string; stub: SkillSchemaStub }> = []
for (const file of readdirSync(libDir).filter((f) => f.endsWith('.ts'))) {
  const mod = (await import(new URL(file, `file://${libDir.replace(/\\/g, '/')}`).href)) as Record<string, unknown>
  for (const [exportName, value] of Object.entries(mod)) {
    if (exportName.endsWith('Schema') && value && typeof value === 'object' && 'params' in (value as object)) {
      stubs.push({ file, stub: value as SkillSchemaStub })
    }
  }
}

describe('skill schema stubs (R1-R3 gate)', () => {
  it('found the stubs — an empty glob must not pass vacuously', () => {
    expect(stubs.length).toBeGreaterThanOrEqual(15)
  })

  it.each(stubs.map((s) => [s.stub.name, s]))('%s: params are a closed object (R2)', (_name, { stub }) => {
    const p = stub.params as Record<string, unknown>
    expect(p.type).toBe('object')
    // No free-form objects — the M1-3 latent OpenAI 400.
    expect(p.properties, 'params must declare properties').toBeTruthy()
    expect(p.additionalProperties).toBe(false)
  })

  it.each(stubs.map((s) => [s.stub.name, s]))('%s: no optional properties (R3)', (_name, { stub }) => {
    const p = stub.params as { properties: Record<string, unknown>; required?: string[] }
    // Strict mode rejects optional properties outright: EVERY property is
    // listed in `required`. Optionality is then expressed by admitting null
    // (R3) — a genuinely mandatory field, like cookMeat's `meat`, stays
    // required and non-nullable, which is correct and strict-safe.
    expect([...(p.required ?? [])].sort()).toEqual([...Object.keys(p.properties ?? {})].sort())
  })

  it.each(stubs.map((s) => [s.stub.name, s]))('%s: nullable enums use anyOf, never a type array (R3)', (_name, { stub }) => {
    const p = stub.params as { properties: Record<string, any> }
    for (const [key, spec] of Object.entries(p.properties ?? {})) {
      // A type array beside enum members is the shape Anthropic strict 400'd
      // on in the first live smoke; the fix was anyOf(enum, null).
      const typeArrayBesideEnum = Array.isArray(spec.type) && Array.isArray(spec.enum)
      expect(typeArrayBesideEnum, `${key}: use anyOf(enum, null), not a type array beside enum`).toBe(false)
      if (Array.isArray(spec.anyOf)) {
        const branches = spec.anyOf.filter((b: any) => b?.enum)
        if (branches.length > 0) {
          expect(spec.anyOf.some((b: any) => b?.type === 'null'), `${key}: anyOf enum must offer null`).toBe(true)
        }
      }
    }
  })

  it.each(stubs.map((s) => [s.stub.name, s]))('%s: promises only codes the wire can carry', (_name, { stub }) => {
    expect(stub.failureCodes.length).toBeGreaterThan(0)
    for (const code of stub.failureCodes) expect(actionFailedCodes).toContain(code)
  })

  it('a stub whose name became a contract verb is byte-equal to its $defs (R1)', () => {
    // Self-activating: vacuous while the skill library and the verb vocabulary
    // are disjoint, load-bearing the day a skill is promoted to a verb.
    const verbs: string[] = actionRequested.properties.action.enum
    const promoted = stubs.filter((s) => verbs.includes(s.stub.name))
    for (const { stub } of promoted) {
      const defsKey = `${stub.name[0]!.toUpperCase()}${stub.name.slice(1)}Params`
      const defs = actionRequested.$defs?.[defsKey]
      expect(defs, `${stub.name} is a contract verb but has no ${defsKey} $defs`).toBeTruthy()
      expect(stub.params).toEqual(defs)
    }
    // Record today's disjointness so the assertion above is understood as
    // dormant-by-fact, not silently skipped.
    expect(promoted.length).toBe(0)
  })
})
