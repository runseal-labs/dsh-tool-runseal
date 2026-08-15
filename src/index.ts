/**
 * RunSeal sandbox provider for DeepSeek Harness: registers as `ctx.sandbox` and
 * confines every wrapped argv through the runseal RPC `execute` — OS-native
 * filesystem/process/resource/network policy on Windows, macOS, and Linux, with
 * audit events and environment scrubbing. `confine()` returns a thin Node
 * wrapper argv; the wrapper runs the command under runseal, forwards streamed
 * stdout/stderr, and exits with the command's exit code, so existing dsh
 * consumers (bash, jobs, fs) see an ordinary subprocess lifecycle.
 *
 * Policy mapping: dsh `read-only` / `workspace-write` / `danger-full-access`
 * map to the same-named runseal sandbox levels. RunSeal additionally offers
 * `workspace-contained` (strict) and `network.proxy` for enterprise routing.
 *
 * Depends only on published dsh base packages — fully out-of-tree.
 * @module dsh-tool-runseal
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, RunnerFailureRule, SandboxEnforcement, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { MODE_TO_POLICY, RunsealEngine, resolveEngineConfig } from './engine.ts'
import type { EngineConfig } from './engine.ts'

export { MODE_TO_POLICY, RunsealEngine, resolveEngineConfig } from './engine.ts'
export type { EngineConfig, RunsealExecuteResult } from './engine.ts'
export { RpcError, RunsealRpcClient } from './rpc-client.ts'
export type { RpcErrorData, RpcClientOptions } from './rpc-client.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'dsh-tool-runseal'

/** Services required by this plugin. */
export const inject = ['sandbox']

/** Plugin configuration. */
export interface Config extends Omit<EngineConfig, 'args'> {
  /** Extra arguments before the `rpc` subcommand. Default `[]`. */
  args?: string[]
  /** Default per-execution timeout in ms (default 600000). */
  timeoutMs?: number
}

/** Schemastery config schema validated by the Cordis loader. */
export const Config: z<Config> = z.object({
  command: z.string().required(),
  args: z.array(String).default([]),
  networkMode: z.union([z.const('unmanaged'), z.const('disabled'), z.const('proxy')]).default('unmanaged'),
  maxStdinBytes: z.number().default(64 * 1024),
  timeoutMs: z.number().default(600_000),
})

/** The wrapper's stable failure prefix (its `runseal: <reason>` stderr line). */
const WRAPPER_FAILURE_PREFIX = 'runseal: '

/** RunSeal RPC error codes that mean the sandbox itself refused or is unavailable. */
const RUNSEAL_DENIAL_CODES = new Set([
  'BACKEND_UNAVAILABLE',
  'SETUP_REQUIRED',
  'SANDBOX_DENIED',
  'POLICY_DENIED',
])

/**
 * Register the RunSeal sandbox provider as `ctx.sandbox`.
 * @param ctx - the plugin context (injects `sandbox`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveEngineConfig(config)
  if (resolved.command.trim() === '') throw new Error('dsh-tool-runseal: command must be a non-empty string')
  const timeoutMs = config.timeoutMs ?? 600_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('dsh-tool-runseal: timeoutMs must be a positive integer')
  }

  const provider = new RunsealSandboxProvider(ctx, resolved, timeoutMs)
  void provider
}

/** The wrapper script path (sibling of this compiled module). */
function wrapperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'wrapper.cjs')
}

/**
 * The RunSeal-backed `ctx.sandbox` implementation. `confine` is synchronous by
 * contract, so it returns the wrapper argv immediately; the wrapper performs
 * the actual RPC execution when the consumer spawns it.
 */
export class RunsealSandboxProvider extends SandboxProvider {
  private readonly engine: RunsealEngine

  constructor(
    ctx: Context,
    private readonly config: ReturnType<typeof resolveEngineConfig>,
    private readonly timeoutMs: number,
  ) {
    super(ctx)
    this.engine = new RunsealEngine(config, undefined)
  }

  /**
   * Wrap argv under a thin Node wrapper that runs the command through runseal.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy for this execution.
   * @returns the wrapper argv with runseal enforcement facts.
   */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const policyId = MODE_TO_POLICY[policy.mode]
    if (policyId === undefined) {
      throw new SandboxUnavailableError(policy.mode, `unknown mode ${policy.mode}`)
    }
    return this.wrap(argv, policy, policyId, 'full')
  }

  private wrap(argv: readonly string[], policy: SandboxPolicy, policyId: string, enforcement: SandboxEnforcement): ConfinedArgv {
    const spec = {
      argv: [...argv],
      cwd: policy.workspaceRoot,
      policy: policyId,
      network: this.config.networkMode,
      timeoutMs: this.timeoutMs,
    }
    return {
      argv: [process.execPath, wrapperPath(), JSON.stringify(spec)],
      enforcement,
      denialSignatures: [...RUNSEAL_DENIAL_CODES],
      runnerFailureRules: RUNNER_FAILURE_RULES,
    }
  }
}

/** Runner-failure rules: the wrapper prints `runseal: <reason>` on RPC errors. */
const RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = [
  {
    fatalSignatures: [WRAPPER_FAILURE_PREFIX],
  },
]