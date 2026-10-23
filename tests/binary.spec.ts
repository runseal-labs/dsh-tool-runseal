import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { c as createTar } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { binaryTarget, resolveBinary, unpackBinary } from '../src/binary.ts'

const directories: string[] = []
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'runseal-installer-'))
  directories.push(path)
  return path
}
function checksum(bytes: Buffer, name: string) { return `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n` }
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('native installer', () => {
  it('maps all six release platforms and rejects unsupported architectures', () => {
    for (const os of ['win32', 'linux', 'darwin']) for (const arch of ['x64', 'arm64']) {
      expect(binaryTarget(os, arch).asset).toMatch(/^runseal-v0\.2\.3-/)
    }
    expect(() => binaryTarget('linux', 'ia32')).toThrow('does not provide')
  })
  it('preserves explicit executable paths and PATH names ahead of the environment override', () => {
    vi.stubEnv('RUNSEAL_BINARY', 'environment-runseal')
    expect(resolveBinary('C:/custom/runseal.exe')).toBe('C:/custom/runseal.exe')
    expect(resolveBinary('runseal')).toBe('runseal')
    expect(resolveBinary('')).toBe('environment-runseal')
  })
  it('installs every Windows helper beside the executable', async () => {
    const target = binaryTarget('win32', 'x64')
    const bytes = Buffer.from(zipSync(Object.fromEntries(target.files.map(name => [name, Buffer.from(name)]))))
    const destination = await temporary()
    await unpackBinary(bytes, checksum(bytes, target.asset), target.asset, target.files, destination)
    for (const name of target.files) expect(await readFile(join(destination, name), 'utf8')).toBe(name)
  })
  it('refuses corrupt archives, wrong checksum filenames, traversal and missing helpers', async () => {
    const target = binaryTarget('win32', 'x64')
    const bytes = Buffer.from(zipSync({ 'runseal.exe': Buffer.from('test') }))
    await expect(unpackBinary(bytes, `${'0'.repeat(64)}  ${target.asset}`, target.asset, target.files, await temporary())).rejects.toThrow('checksum mismatch')
    await expect(unpackBinary(bytes, checksum(bytes, 'other.zip'), target.asset, target.files, await temporary())).rejects.toThrow('checksum mismatch')
    await expect(unpackBinary(bytes, checksum(bytes, target.asset), target.asset, target.files, await temporary())).rejects.toThrow('missing')
    const traversal = Buffer.from(zipSync({ '../runseal.exe': Buffer.from('bad') }))
    await expect(unpackBinary(traversal, checksum(traversal, target.asset), target.asset, target.files, await temporary())).rejects.toThrow('Unexpected')
  })
  it('extracts the Unix executable from a verified tarball', async () => {
    const source = await temporary()
    const target = binaryTarget('linux', 'x64')
    await mkdir(join(source, 'content'))
    await writeFile(join(source, 'content', 'runseal'), 'native executable')
    const archive = join(source, target.asset)
    await createTar({ file: archive, cwd: join(source, 'content'), gzip: true }, ['runseal'])
    const bytes = await readFile(archive)
    const destination = await temporary()
    await unpackBinary(bytes, checksum(bytes, target.asset), target.asset, target.files, destination)
    expect(await readFile(join(destination, 'runseal'), 'utf8')).toBe('native executable')
  })
  it('rejects non-file tar entries instead of extracting arbitrary paths', async () => {
    const source = await temporary()
    await mkdir(join(source, 'unexpected'))
    const target = binaryTarget('linux', 'x64')
    const path = join(source, target.asset)
    await createTar({ file: path, cwd: source, gzip: true }, ['unexpected'])
    const bytes = await readFile(path)
    await expect(unpackBinary(bytes, checksum(bytes, target.asset), target.asset, target.files, await temporary())).rejects.toThrow('Unexpected')
  })
})
