/** Run with the installed desktop Electron in Node mode; never alters dsh or ACLs. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') {
  throw new Error('Run this script with the installed DeepSeek Harness executable and ELECTRON_RUN_AS_NODE=1 so its ASAR assets are read through Electron.')
}
const node = process.argv[2]
if (!node || !isAbsolute(node)) throw new Error('Supply the absolute path of an accessible standalone Node executable.')
const output = resolve(process.argv[3] ?? join(homedir(), '.dsh', 'runseal-runtime', 'ptc'))
const probe = JSON.parse(execFileSync(node, ['-e', 'console.log(JSON.stringify({version:process.versions.node,electron:process.versions.electron??null}))'], {
  encoding: 'utf8', windowsHide: true, timeout: 10000,
}))
const [major, minor] = probe.version.split('.').map(Number)
if (probe.electron !== null || !(major >= 24 || major === 22 && minor >= 19)) throw new Error('PTC requires standalone Node ^22.19 or >=24, not Electron.')
const resources = process.platform === 'darwin'
  ? resolve(dirname(process.execPath), '../Resources')
  : join(dirname(process.execPath), 'resources')
const source = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-ptc-runtime-node')
const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const files = []
for (const name of ['process', 'persistent-process']) {
  const original = join(source, 'lib', `${name}.js`)
  const bytes = readFileSync(original)
  const sha256 = digest(bytes)
  const destination = join(output, metadata.version, sha256, `${name}.mjs`)
  mkdirSync(dirname(destination), { recursive: true })
  if (!existsSync(destination)) writeFileSync(destination, bytes, { flag: 'wx' })
  if (digest(readFileSync(destination)) !== sha256) throw new Error(`Bootstrap checksum mismatch: ${destination}`)
  files.push({ source: original, path: destination, sha256, bytes: bytes.length })
}
const manifest = { package: metadata.name, version: metadata.version, node, nodeVersion: probe.version, files }
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
const patch = [{ id: 'ptc-runtime', config: { executionMode: 'per-call', launch: { kind: 'node-script', executable: node, bootstrapPath: files[0].path } } }]
// JSON is valid YAML; keep the generated patch reviewable and separate from profiles.
writeFileSync(join(output, 'cordis.patch.yml'), JSON.stringify(patch, null, 2) + '\n')
console.log(JSON.stringify({ ...manifest, patch: join(output, 'cordis.patch.yml') }, null, 2))
