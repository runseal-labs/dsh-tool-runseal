import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedSandboxMode } from '@deepseek-ai/dsh-sandbox'
import { RpcError } from './rpc-client.ts'

/** Keep RunSeal's original failure while exposing dsh's stable error code. */
export function sandboxUnavailable(mode: ConfinedSandboxMode, cause: unknown): SandboxUnavailableError {
  const detail = cause instanceof RpcError ? `${cause.code}: ${cause.message}` : String(cause)
  const error = new SandboxUnavailableError(mode, detail)
  Object.defineProperty(error, 'cause', { value: cause, configurable: true })
  return error
}
