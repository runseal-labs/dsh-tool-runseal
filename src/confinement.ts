import { fileURLToPath } from 'node:url'

export const wrapperPath = fileURLToPath(new URL('./wrapper.cjs', import.meta.url))

export interface ConfinedSpec {
  argv: string[]
  cwd: string
  policy: 'read-only' | 'workspace-write' | 'danger-full-access'
  network: 'unmanaged' | 'disabled' | 'proxy'
  timeoutMs: number
}

/** Only unwrap this plugin's exact runner shape; other argv remain ordinary executions. */
export function confinedSpec(argv: readonly string[]): ConfinedSpec | undefined {
  if (argv[0] !== process.execPath || argv[1] !== wrapperPath) return undefined
  if (argv.length !== 3) throw new Error('runseal: invalid confined argv')
  const value = JSON.parse(argv[2]!) as ConfinedSpec
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || typeof value.cwd !== 'string' || !['read-only', 'workspace-write', 'danger-full-access'].includes(value.policy)
      || !['unmanaged', 'disabled', 'proxy'].includes(value.network)
      || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1) throw new Error('runseal: invalid confinement specification')
  return value
}
