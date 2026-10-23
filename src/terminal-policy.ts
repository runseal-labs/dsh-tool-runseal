import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { confinedSpec } from './confinement.ts'

/** dsh user terminals carry a live session identity but arrive without confinement. */
export async function confineSessionTerminal(ctx: Context, spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalSpawnSpec> {
  const id = spec.env?.DSH_SESSION_ID
  if (!spec.shellActivity || id === undefined || confinedSpec(spec.argv)) return spec
  const session = ctx.get('sessions')?.get(id as SessionId)
  const policies = ctx.get('sandboxPolicy')
  if (!session || !policies) throw new Error('runseal: cannot resolve browser terminal session policy')
  const policy = policies.resolve({ session })
  if (policy.mode === 'danger-full-access') return spec
  const sandbox = ctx.get('sandbox')
  if (!sandbox) throw new Error('runseal: browser terminal sandbox is unavailable')
  const confined = await sandbox.confine(spec.argv, { ...policy, mode: policy.mode }, spec.signal)
  spec.signal?.throwIfAborted()
  return { ...spec, argv: confined.argv }
}
