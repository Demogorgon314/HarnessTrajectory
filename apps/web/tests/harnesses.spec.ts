import { describe, expect, test } from 'vitest'
import { allHarnessKinds, harnessMeta } from '../src/harnesses.tsx'

describe('harness registry', () => {
  test('every core kind resolves to a registry entry or the fallback', () => {
    for (const kind of allHarnessKinds()) {
      const meta = harnessMeta(kind)
      expect(meta.kind).toBe(kind)
      expect(meta.resumeCommand({ id: 's1', cwd: null })).toBeTruthy()
    }
  })

  test('devin resumes through `devin -r` in the session directory', () => {
    const meta = harnessMeta('devin')
    expect(meta.label).toBe('Devin CLI')
    expect(meta.resumeCommand({ id: 'smoggy-gold', cwd: '/work/project' }))
      .toBe(`cd /work/project && devin -r smoggy-gold`)
    expect(meta.resumeCommand({ id: 'smoggy-gold', cwd: null })).toBe('devin -r smoggy-gold')
  })

  test('pi resumes through `pi --session` in the session directory', () => {
    const meta = harnessMeta('pi')
    expect(meta.label).toBe('Pi')
    expect(meta.resumeCommand({ id: 'abc123', cwd: '/work/project' }))
      .toBe(`cd /work/project && pi --session abc123`)
    expect(meta.resumeCommand({ id: 'abc123', cwd: null })).toBe('pi --session abc123')
  })

  test('opencode resumes through `opencode --session` in the session directory', () => {
    const meta = harnessMeta('opencode')
    expect(meta.label).toBe('OpenCode')
    expect(meta.resumeCommand({ id: 'ses_abc123', cwd: '/work/project' }))
      .toBe(`cd /work/project && opencode --session ses_abc123`)
    expect(meta.resumeCommand({ id: 'ses_abc123', cwd: null })).toBe('opencode --session ses_abc123')
  })
})
