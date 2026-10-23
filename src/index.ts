/**
 * RunSeal sandbox provider for DeepSeek Harness: registers as `ctx.sandbox` and
 * confines every wrapped argv through the runseal RPC `execute` — OS-native
 * filesystem and process policy, optional network controls, with
 * audit events and environment scrubbing. `confine()` returns a thin Node
 * wrapper argv; the wrapper runs the command under runseal, forwards streamed
 * stdout/stderr, and exits with the command's exit code, so existing dsh
 * consumers (bash, jobs, fs) see an ordinary subprocess lifecycle.
 *
 * Policy mapping: dsh `read-only` / `workspace-write` map to the same-named
 * RunSeal sandbox levels. dsh bypasses this seam for `danger-full-access`. RunSeal additionally offers
 * `workspace-contained` (not exposed by dsh modes) and authenticated proxy networking.
 *
 * Depends only on published dsh base packages — fully out-of-tree.
 * @module dsh-tool-runseal
 */

import { wrapperPath } from './confinement.ts'
import { sandboxUnavailable } from './errors.ts'
import { RunsealSubprocessRuntime } from './subprocess.ts'
export { RunsealSubprocessRuntime } from './subprocess.ts'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, RunnerFailureRule, SandboxEnforcement, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { MODE_TO_POLICY, resolveEngineConfig } from './engine.ts'
import type { EngineConfig } from './engine.ts'

export { MODE_TO_POLICY, RunsealEngine, resolveEngineConfig } from './engine.ts'
export type { EngineConfig, RunsealExecuteResult } from './engine.ts'
export { RpcError, RunsealRpcClient } from './rpc-client.ts'
export type { RpcErrorData, RpcClientOptions } from './rpc-client.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'dsh-tool-runseal'

/** This plugin provides sandbox and does not depend on another sandbox provider. */
export const inject: string[] = []

/** Plugin configuration. */
export interface Config extends Omit<EngineConfig, 'args'> {
  /** Extra arguments before the `rpc` subcommand. Default `[]`. */
  args?: string[]
  /** Register the RPC-owned subprocess service. Disable only for sandbox-only integrations. */
  subprocess?: boolean
  /** Default per-execution timeout in ms (default 600000). */
  timeoutMs?: number
  /**
   * On Windows, automatically run `runseal setup windows-sandbox --elevate` for
   * the workspace when a confined execution fails because setup is missing or
   * stale, then retry once. The elevation prompts the user through UAC.
   * Default `true`.
   */
  autoSetup?: boolean
}

/** Schemastery config schema validated by the Cordis loader. */
export type LiveConfig = { [K in keyof Required<Config>]: K extends 'subprocess' ? boolean : Volatile<Required<Config>[K]> }
export const Config: z<Config, LiveConfig> = z.object({
  command: z.string().default('').volatile(),
  subprocess: z.boolean().default(true),
  args: z.array(String).default([]).volatile(),
  networkMode: z.union([z.const('unmanaged'), z.const('disabled'), z.const('proxy')]).default('unmanaged').volatile(),
  maxStdinBytes: z.number().min(1).step(1).default(64 * 1024).volatile(),
  timeoutMs: z.number().min(1).step(1).default(600_000).volatile(),
  autoSetup: z.boolean().default(true).volatile(),
})

/** The wrapper's stable failure prefix (its `runseal: <reason>` stderr line). */
const WRAPPER_FAILURE_PREFIX = 'runseal: '

/** Child stderr denial dialects; runner/RPC failures are classified separately. */
const DENIAL_SIGNATURES = ['Read-only file system', 'Permission denied', 'Operation not permitted', 'Access is denied', 'Access to the path', 'UnauthorizedAccessException', '拒绝访问', '不允许的操作', '权限不够']

/**
 * Register the RunSeal sandbox provider as `ctx.sandbox`.
 * @param ctx - the plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: LiveConfig): void {
  const read = (): Config => ({
    command: config.command.get(), args: [...config.args.get()], networkMode: config.networkMode.get(),
    maxStdinBytes: config.maxStdinBytes.get(), timeoutMs: config.timeoutMs.get(), autoSetup: config.autoSetup.get(),
  })
  if (config.subprocess !== false) new RunsealSubprocessRuntime(ctx, () => resolveEngineConfig(read()))
  new RunsealSandboxProvider(ctx, read)
}

/** Confine each command using a snapshot of the current profile settings. */
export class RunsealSandboxProvider extends SandboxProvider {

  constructor(
    ctx: Context,
    private readonly readConfig: () => Config,
  ) {
    super(ctx)
  }

  /**
   * Wrap argv under a thin Node wrapper that runs the command through runseal.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy for this execution.
   * @returns the wrapper argv with runseal enforcement facts.
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    const policyId = MODE_TO_POLICY[policy.mode]
    if (policyId === undefined) {
      throw new SandboxUnavailableError(policy.mode, `unknown mode ${policy.mode}`)
    }
    try {
      // full concerns the requested file effects, not backend maturity or network.
      // RunSeal rejects unavailable enforcement at admission; it never falls back.
      return this.wrap(argv, policy, policyId, 'full')
    } catch (error) {
      signal?.throwIfAborted()
      throw sandboxUnavailable(policy.mode, error)
    }
  }

  private wrap(argv: readonly string[], policy: SandboxPolicy, policyId: string, enforcement: SandboxEnforcement): ConfinedArgv {
    const snapshot = this.readConfig()
    const config = resolveEngineConfig(snapshot)
    const spec = {
      command: config.command,
      args: config.args,
      argv: [...argv],
      cwd: policy.workspaceRoot,
      policy: policyId,
      network: config.networkMode,
      timeoutMs: snapshot.timeoutMs ?? 600_000,
      autoSetup: snapshot.autoSetup ?? true,
    }
    return {
      argv: [process.execPath, wrapperPath, JSON.stringify(spec)],
      enforcement,
      denialSignatures: [...DENIAL_SIGNATURES],
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
