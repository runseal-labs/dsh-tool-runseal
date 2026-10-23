/**
 * RunSeal execution engine: maps dsh sandbox policies onto runseal RPC
 * `execute` requests and interprets the event stream. One RPC child per execution
 * owns its lifecycle; each execution produces `execution.stdout` /
 * `execution.stderr` events (base64 payloads) and a final result carrying
 * `exit_code`/signal/truncation. Cancellation maps to `cancelExecution`.
 * @module dsh-tool-runseal/engine
 */

import { StringDecoder } from 'node:string_decoder'
import { resolveBinary } from './binary.ts'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { RpcError, RunsealRpcClient } from './rpc-client.ts'
import type { RpcErrorData } from './rpc-client.ts'

/** How completely the runseal backend enforces a policy on this host. */
export type RunsealEnforcement = 'full' | 'partial'

/** Mapping from dsh sandbox modes to runseal policy ids. */
export const MODE_TO_POLICY: Record<SandboxMode, string> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'danger-full-access': 'danger-full-access',
}

/** One executed command's outcome. */
export interface RunsealExecuteResult {
  exitCode: number
  signal: string | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  executionId: string
}

/** Per-execution streamed output captured from events. */
interface CapturedOutput {
  stdout: string
  stderr: string
  exitCode: number | undefined
  signal: string | null | undefined
  outputTruncated: boolean
  finished: boolean
}

/** Engine configuration. */
export interface EngineConfig {
  /** The runseal executable: absolute path or PATH-resolved name. */
  command?: string
  /** Extra arguments before the `rpc` subcommand. Default `[]`. */
  args?: readonly string[]
  /** Default network mode. Default `unmanaged`. */
  networkMode?: 'unmanaged' | 'disabled' | 'proxy'
  /** Maximum stdin bytes accepted for `bytes` mode. Default 64 KiB (runseal cap). */
  maxStdinBytes?: number
}

/** Resolved engine configuration. */
export type ResolvedEngineConfig = Required<Omit<EngineConfig, 'args'>> & {
  readonly args: readonly string[]
}

/** Resolve defaults. */
export function resolveEngineConfig(config: EngineConfig): ResolvedEngineConfig {
  return {
    command: resolveBinary(config.command),
    args: config.args ?? [],
    networkMode: config.networkMode ?? 'unmanaged',
    maxStdinBytes: config.maxStdinBytes ?? 64 * 1024,
  }
}

/** Execution limits mirrored from runseal policy resources. */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * The RunSeal execution engine. Threads one RPC client; each `execute` awaits
 * the request's result while assembling streamed events into the outcome.
 */
export class RunsealEngine {
  private readonly active = new Map<string, RunsealRpcClient>()

  constructor(
    private readonly config: ResolvedEngineConfig,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /**
   * Run one command under a runseal policy.
   * @param argv - the command and arguments.
   * @param cwd - the execution working directory.
   * @param policy - the runseal policy id (`read-only` etc).
   * @param stdin - optional stdin bytes; omitted means empty.
   * @param timeoutMs - optional execution timeout.
   * @returns the streamed outcome.
   */
  async execute(
    argv: readonly string[],
    cwd: string,
    policy: string,
    stdin?: Uint8Array,
    timeoutMs?: number,
  ): Promise<RunsealExecuteResult> {
    if (stdin && stdin.byteLength > this.config.maxStdinBytes) throw new Error('runseal stdin exceeds maxStdinBytes')
    let executionId: string | undefined
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const captured: CapturedOutput = {
      stdout: '',
      stderr: '',
      exitCode: undefined,
      signal: undefined,
      outputTruncated: false,
      finished: false,
    }
    const client = new RunsealRpcClient(
      { command: this.config.command, args: this.config.args, ...this.signal === undefined ? {} : { signal: this.signal } },
      (event) => {
        switch (event.type) {
          case 'execution.stdout':
            captured.stdout += stdoutDecoder.write(decodeEventData(event))
            break
          case 'execution.stderr':
            captured.stderr += stderrDecoder.write(decodeEventData(event))
            break
          case 'execution.finished':
            captured.exitCode = typeof event.exit_code === 'number' ? event.exit_code : undefined
            captured.signal = typeof event.signal === 'string' ? event.signal : null
            captured.outputTruncated = event.output_truncated === true
            captured.finished = true
            break
          default:
            break
        }
      },
    )
    try {
      const params: Record<string, unknown> = {
        command: [...argv],
        cwd,
        policy,
        network: this.config.networkMode,
        ...stdin !== undefined && stdin.length > 0
          ? { stdin: { mode: 'bytes', data: `base64:${Buffer.from(stdin).toString('base64')}`, encoding: 'base64' } }
          : {},
        ...timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {},
      }
      const result = await client.execute(params, id => { executionId = id; this.active.set(id, client) }) as Record<string, unknown>
      if (result.status === 'failed' || result.error) {
        const data = result.error as RpcErrorData | undefined
        throw new RpcError(data?.reason ?? 'runseal execution failed', data ?? { code: 'EXECUTION_FAILED', reason: 'execution failed' })
      }
      // The result carries the complete output even if events were dropped;
      // prefer the result's authoritative fields over event assembly.
      return {
        exitCode: typeof result.exit_code === 'number' ? result.exit_code : (captured.exitCode ?? 1),
        signal: typeof result.signal === 'string' ? result.signal : (captured.signal ?? null),
        stdout: typeof result.stdout === 'string' ? result.stdout : captured.stdout + stdoutDecoder.end(),
        stderr: typeof result.stderr === 'string' ? result.stderr : captured.stderr + stderrDecoder.end(),
        outputTruncated: result.output_truncated === true || captured.outputTruncated,
        executionId: typeof result.execution_id === 'string' ? result.execution_id : 'unknown',
      }
    } finally {
      if (executionId) this.active.delete(executionId)
      client.destroy()
    }
  }

  /** Report runseal's capability/version facts. */
  async status(): Promise<{ version: string; ready: boolean; error?: string }> {
    const client = new RunsealRpcClient(
      { command: this.config.command, args: this.config.args, ...this.signal === undefined ? {} : { signal: this.signal } },
      () => undefined,
    )
    try {
      const result = await client.request('getVersion', {}) as Record<string, unknown>
      const version = typeof result.version === 'string' ? result.version : String(result.runseal_version ?? 'unknown')
      return { version, ready: true }
    } catch (error: unknown) {
      return {
        version: 'unknown',
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      client.destroy()
    }
  }

  /** Cancel one execution by id. */
  async cancel(executionId: string): Promise<void> {
    const client = this.active.get(executionId)
    if (!client) throw new Error(`runseal execution is not active: ${executionId}`)
    await client.request('cancelExecution', { execution_id: executionId })
  }
}

/** Decode an `execution.stdout`/`execution.stderr` event's base64 payload. */
function decodeEventData(event: Record<string, unknown>): Buffer {
  const data = typeof event.data === 'string' ? event.data : ''
  return data.startsWith('base64:') ? Buffer.from(data.slice(7), 'base64') : Buffer.from(data)
}

export { DEFAULT_MAX_OUTPUT_BYTES }
