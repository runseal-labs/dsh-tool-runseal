import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import * as Plugin from '../src/index.ts'
import { MODE_TO_POLICY } from '../src/index.ts'
import { RpcError, RunsealRpcClient } from '../src/rpc-client.ts'

/** A scripted runseal RPC child for protocol tests (driven by env). */
import { fileURLToPath } from 'node:url'
const FAKE_SCRIPT = fileURLToPath(new URL('./fake-runseal.cjs', import.meta.url))

function fakeRunseal(lines: string[]): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: [FAKE_SCRIPT],
    env: { FAKE_RUNSEAL_LINES: JSON.stringify(lines) },
  }
}

describe('MODE_TO_POLICY', () => {
  it('maps every dsh mode to the same-named runseal policy', () => {
    expect(MODE_TO_POLICY).toEqual({
      'read-only': 'read-only',
      'workspace-write': 'workspace-write',
      'danger-full-access': 'danger-full-access',
    })
  })
})

describe('RpcError', () => {
  it('carries the stable runseal error code', () => {
    const error = new RpcError('boom', { code: 'BACKEND_UNAVAILABLE', reason: 'setup required' })
    expect(error.code).toBe('BACKEND_UNAVAILABLE')
    expect(error.message).toBe('boom')
  })
})

describe('RunsealRpcClient', () => {
  it('parses event notifications and request results', async () => {
    const events: Record<string, unknown>[] = []
    const fake = fakeRunseal([
      JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'execution.stdout', data: 'base64:aGk=' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { exit_code: 0 } }),
    ])
    const child = new RunsealRpcClient(
      { command: fake.command, args: fake.args, env: fake.env },
      event => events.push(event),
    )
    const result = await child.request('execute', {})
    expect(result).toEqual({ exit_code: 0 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'execution.stdout', data: 'base64:aGk=' })
    child.destroy()
  })

  it('rejects with the structured error data', async () => {
    const fake = fakeRunseal([
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'unavailable', data: { code: 'BACKEND_UNAVAILABLE', reason: 'setup' } } }),
    ])
    const child = new RunsealRpcClient(
      { command: fake.command, args: fake.args, env: fake.env },
      () => undefined,
    )
    await expect(child.request('execute', {})).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    child.destroy()
  })
})

describe('RunsealSandboxProvider confine', () => {
  function mount(): { ctx: Context; sandbox: SandboxProvider } {
    const ctx = new Context()
    return { ctx, sandbox: new Plugin.RunsealSandboxProvider(
      ctx,
      { command: 'runseal', args: [], networkMode: 'unmanaged', maxStdinBytes: 65536 },
      600_000,
      true,
    ) }
  }

  function policy(mode: SandboxPolicy['mode']): SandboxPolicy {
    return { mode, workspaceRoot: 'C:\\workspace' }
  }

  it('wraps argv with the node wrapper and runseal policy spec', () => {
    const { sandbox } = mount()
    const confined = sandbox.confine(['bash', '-c', 'echo hi'], policy('read-only'))
    expect(confined.argv[0]).toBe(process.execPath)
    expect(confined.argv[1]).toContain('wrapper.cjs')
    const spec = JSON.parse(confined.argv[2] as string)
    expect(spec).toMatchObject({
      argv: ['bash', '-c', 'echo hi'],
      cwd: 'C:\\workspace',
      policy: 'read-only',
      network: 'unmanaged',
      autoSetup: true,
    })
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toContain('BACKEND_UNAVAILABLE')
    expect(confined.runnerFailureRules[0]!.fatalSignatures).toEqual(['runseal: '])
  })

  it('maps workspace-write mode', () => {
    const { sandbox } = mount()
    const confined = sandbox.confine(['cmd', '/c', 'dir'], policy('workspace-write'))
    const spec = JSON.parse(confined.argv[2] as string)
    expect(spec.policy).toBe('workspace-write')
  })
})