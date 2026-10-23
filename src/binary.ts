import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
import { x as extractTar } from 'tar'

/** Explicit native release pin; plugin-only patches need not change it. Never resolve `latest`. */
export const RUNSEAL_VERSION = '0.2.2'
const releaseRoot = `https://github.com/runseal-labs/runseal/releases/download/v${RUNSEAL_VERSION}`
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const maxArchiveBytes = 64 * 1024 * 1024
const executeFile = promisify(execFile)

async function verifyVersion(path: string): Promise<void> {
  const { stdout } = await executeFile(path, ['--version'], { timeout: 10_000, windowsHide: true })
  if (stdout.trim() !== RUNSEAL_VERSION) throw new Error(`RunSeal executable version mismatch: expected ${RUNSEAL_VERSION}`)
  const structured = await executeFile(path, ['version', '--json'], { timeout: 10_000, windowsHide: true })
  const info = JSON.parse(structured.stdout) as Record<string, unknown>
  if (info.runseal_version !== RUNSEAL_VERSION || info.protocol_version !== 'runseal.protocol/v2') {
    throw new Error('RunSeal executable does not provide the pinned version and protocol v2')
  }
}

export function binaryTarget(platform: string = process.platform, arch: string = process.arch) {
  const targets: Record<string, string> = {
    'win32-x64': 'windows-x86_64.zip', 'win32-arm64': 'windows-arm64.zip',
    'linux-x64': 'linux-x86_64.tar.gz', 'linux-arm64': 'linux-aarch64.tar.gz',
    'darwin-x64': 'macos-x86_64.tar.gz', 'darwin-arm64': 'macos-arm64.tar.gz',
  }
  const suffix = targets[`${platform}-${arch}`]
  if (!suffix) throw new Error(`RunSeal does not provide a binary for ${platform}/${arch}; configure a custom command and use RUNSEAL_SKIP_DOWNLOAD=1 when installing.`)
  const files = platform === 'win32'
    ? ['runseal.exe', 'runseal-windows-sandbox-setup.exe', 'runseal-command-runner.exe']
    : ['runseal']
  return { asset: `runseal-v${RUNSEAL_VERSION}-${suffix}`, files, directory: `${RUNSEAL_VERSION}-${platform}-${arch}` }
}

export function resolveBinary(command?: string): string {
  const custom = command?.trim() || process.env.RUNSEAL_BINARY?.trim()
  if (custom) return custom
  const target = binaryTarget()
  const path = join(packageRoot, '.runseal', target.directory, target.files[0]!)
  if (!existsSync(path)) throw new Error('RunSeal binary is missing. Run npm rebuild dsh-tool-runseal (enable lifecycle scripts), or configure a custom RunSeal executable.')
  return path
}

async function download(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`RunSeal download failed: HTTP ${response.status} (${url})`)
  if (!response.body) throw new Error('RunSeal download returned an empty body')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > limit) throw new Error('RunSeal download exceeds size limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Verify before extraction; only flat, expected executable files are accepted. */
export async function unpackBinary(archive: Buffer, checksum: string, asset: string, files: string[], destination: string): Promise<void> {
  const match = /^([a-fA-F0-9]{64}) [ *]([^\r\n]+)\r?\n?$/.exec(checksum)
  if (!match || match[2] !== asset || createHash('sha256').update(archive).digest('hex') !== match[1]!.toLowerCase()) {
    throw new Error(`RunSeal checksum mismatch for ${asset}`)
  }
  const seen = new Set<string>()
  let extractedBytes = 0
  const accept = (name: string, size: number) => {
    if (!files.includes(name) || seen.has(name) || !Number.isSafeInteger(size) || size < 1) throw new Error(`Unexpected RunSeal archive entry: ${name}`)
    extractedBytes += size
    if (extractedBytes > maxArchiveBytes) throw new Error('RunSeal extracted files exceed size limit')
    seen.add(name)
  }
  if (asset.endsWith('.zip')) {
    const entries = unzipSync(archive, { filter: entry => { accept(entry.name, entry.originalSize); return true } })
    for (const [name, bytes] of Object.entries(entries)) await writeFile(join(destination, name), bytes, { flag: 'wx', mode: 0o755 })
  } else {
    const archivePath = join(destination, 'download.tar.gz')
    await writeFile(archivePath, archive)
    let invalidEntry: Error | undefined
    await extractTar({ file: archivePath, cwd: destination, strict: true, filter: (name, entry) => {
      if (invalidEntry) return false
      // tar invokes filters from stream callbacks; throwing there bypasses its promise.
      try {
        if (!('type' in entry) || entry.type !== 'File') throw new Error('Unexpected RunSeal archive entry type')
        accept(name, entry.size)
        return true
      } catch (error) {
        invalidEntry = error instanceof Error ? error : new Error(String(error))
        return false
      }
    } })
    if (invalidEntry) throw invalidEntry
    await rm(archivePath)
  }
  for (const name of files) {
    if (!seen.has(name)) throw new Error(`RunSeal archive is missing ${name}`)
    await chmod(join(destination, name), 0o755)
  }
}

export async function installBinary(): Promise<string | undefined> {
  if (process.env.RUNSEAL_SKIP_DOWNLOAD === '1' || process.env.RUNSEAL_BINARY?.trim()) return
  const target = binaryTarget()
  const destination = join(packageRoot, '.runseal', target.directory)
  // Each installed package owns its binaries. Do not reuse arbitrary PATH entries.
  if (target.files.every(name => existsSync(join(destination, name)))) {
    await verifyVersion(join(destination, target.files[0]!))
    return join(destination, target.files[0]!)
  }
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(join(dirname(destination), '.install-'))
  try {
    const checksum = (await download(`${releaseRoot}/${target.asset}.sha256`, 4096)).toString('utf8')
    const archive = await download(`${releaseRoot}/${target.asset}`, maxArchiveBytes)
    await unpackBinary(archive, checksum, target.asset, target.files, staging)
    await verifyVersion(join(staging, target.files[0]!))
    await rename(staging, destination)
    return join(destination, target.files[0]!)
  } finally { await rm(staging, { recursive: true, force: true }) }
}
