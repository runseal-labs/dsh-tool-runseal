import { binaryTarget, RUNSEAL_VERSION } from '../lib/binary.js'

// npm must not advertise automatic installation until its pinned release is public.
const tag = `v${RUNSEAL_VERSION}`
const response = await fetch(`https://api.github.com/repos/runseal-labs/runseal/releases/tags/${tag}`, {
  headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000),
})
if (!response.ok) throw new Error(`Cannot publish: public RunSeal ${tag} release is unavailable (HTTP ${response.status}). Publish and verify RunSeal first.`)
const release = await response.json()
if (release.draft || release.prerelease || release.tag_name !== tag) throw new Error(`Cannot publish: ${tag} must be a public stable release.`)
const assets = new Map(release.assets.map(asset => [asset.name, asset]))
for (const platform of ['win32', 'linux', 'darwin']) for (const arch of ['x64', 'arm64']) {
  const { asset } = binaryTarget(platform, arch)
  for (const name of [asset, `${asset}.sha256`]) {
    const item = assets.get(name)
    if (!item || item.state !== 'uploaded' || item.size <= 0) throw new Error(`Cannot publish: missing native release asset ${name}`)
  }
}
console.log(`Public native release verified: ${tag}, six platforms with checksums`)
