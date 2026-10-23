import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { confineSessionTerminal } from '../src/terminal-policy.ts'

const spec: SubprocessTerminalSpawnSpec = { argv: ['cmd.exe'], cwd: 'C:/workspace/nested', rows: 24, cols: 80,
  terminalType: 'xterm', shellActivity: true, graceMs: 1000, env: { DSH_SESSION_ID: 'session-a' } }
function harness(mode = 'workspace-write', present = true) {
  const session = { id: 'session-a', header: { cwd: 'C:/workspace' } }
  const resolve = vi.fn(() => ({ mode, workspaceRoot: session.header.cwd }))
  const confine = vi.fn(async () => ({ argv: ['confined'], enforcement: 'full' }))
  const getSession = vi.fn(() => present ? session : undefined)
  const services = { sessions: { get: getSession }, sandboxPolicy: { resolve }, sandbox: { confine } }
  const ctx = { get: (key: keyof typeof services) => services[key] } as unknown as Context
  return { ctx, session, resolve, confine, getSession }
}
describe('browser terminal policy', () => {
  it.each(['workspace-write', 'read-only'])('uses the live %s policy and immutable workspace root', async mode => {
    const h = harness(mode)
    const result = await confineSessionTerminal(h.ctx, spec)
    expect(h.getSession).toHaveBeenCalledWith('session-a')
    expect(h.resolve).toHaveBeenCalledWith({ session: h.session })
    expect(h.confine).toHaveBeenCalledWith(spec.argv, { mode, workspaceRoot: 'C:/workspace' }, undefined)
    expect(result.argv).toEqual(['confined'])
    expect(result.cwd).toBe(spec.cwd)
  })
  it('preserves an explicitly resolved full-access session', async () => {
    const h = harness('danger-full-access')
    expect(await confineSessionTerminal(h.ctx, spec)).toBe(spec)
    expect(h.confine).not.toHaveBeenCalled()
  })
  it('fails closed for an unknown session or absent policy service', async () => {
    await expect(confineSessionTerminal(harness('workspace-write', false).ctx, spec)).rejects.toThrow('session policy')
    await expect(confineSessionTerminal({ get: () => undefined } as unknown as Context, spec)).rejects.toThrow('session policy')
  })
  it('does not reinterpret anonymous or non-user terminals', async () => {
    const h = harness()
    await confineSessionTerminal(h.ctx, { ...spec, env: {} })
    await confineSessionTerminal(h.ctx, { ...spec, shellActivity: false })
    expect(h.getSession).not.toHaveBeenCalled()
  })
})
