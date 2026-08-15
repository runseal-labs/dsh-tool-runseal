# dsh-tool-runseal

A standalone [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: replaces the built-in sandbox with [RunSeal](https://github.com/runseal-labs/runseal) — an OS-native, policy-governed execution environment with enforceable filesystem, process, resource, and network boundaries, plus structured audit events and environment-credential scrubbing.

Fully out-of-tree: depends only on published dsh base packages. Registers as `ctx.sandbox`, so every existing sandbox consumer (bash, jobs, fs) confines through RunSeal automatically.

## What it provides

| Item | Description |
|---|---|
| `ctx.sandbox` provider | Subclasses `SandboxProvider`; `confine()` wraps argv through a thin Node wrapper that runs the command under `runseal rpc` |
| Policy mapping | dsh `read-only` / `workspace-write` / `danger-full-access` → same-named RunSeal sandbox levels |
| Network modes | `unmanaged` (default), `disabled`, `proxy` (enterprise routing + credential redaction) |
| Streaming output | `execution.stdout` / `execution.stderr` RPC events forwarded to the consumer's stdio; exit code propagates |
| Fail closed | Missing setup or an unavailable backend rejects with `runseal: <reason>` on stderr and a non-zero exit, never silent passthrough |
| Audit | Every execution emits `execution.requested` → `policy.resolved` → `execution.finished` events and a JSONL audit record |

## Install

Prerequisites: a `runseal` binary on PATH (or an absolute `command` path). Prebuilt binaries for Windows / macOS / Linux are published on the [runseal releases](https://github.com/runseal-labs/runseal/releases) page.

On Windows, confined modes (`read-only`, `workspace-write`) require the sandbox setup once:

```sh
runseal setup windows-sandbox --cwd <workspace> --elevate
```

Then install the plugin into your dsh profile:

```sh
cd ~/.dsh/profiles/web && pnpm add dsh-tool-runseal
# or from source:
#   git clone https://github.com/runseal-labs/dsh-tool-runseal && cd dsh-tool-runseal && pnpm install && pnpm build
```

## Mount into dsh

RunSeal takes over `ctx.sandbox`. Patch the base bundle's `sandbox-local` row out and insert this plugin:

```yaml
# cordis.patch.yml — replace the built-in local sandbox with RunSeal
- id: sandbox-local
  disabled: true

- insert:
    - id: sandbox-runseal
      name: 'dsh-tool-runseal'
      inject: [sandbox]
      config:
        # runseal executable: absolute path, or a name resolved on PATH
        command: 'runseal'
        # network mode: unmanaged (default), disabled, or proxy
        networkMode: 'unmanaged'
        # default per-execution timeout in ms
        timeoutMs: 600000
```

> Note: `ctx.sandbox` is a single-service key. The base bundle's `sandbox-local` row must be disabled (or replaced) so the RunSeal provider registers instead. Keep a backup of your patch before switching.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `command` | — (required) | The runseal executable: absolute path or PATH-resolved name. |
| `args` | `[]` | Extra arguments before the `rpc` subcommand (no shell). |
| `networkMode` | `unmanaged` | Network policy: `unmanaged`, `disabled`, or `proxy`. |
| `maxStdinBytes` | `65536` | Maximum stdin bytes for the `bytes` mode (runseal cap). |
| `timeoutMs` | `600000` | Default per-execution timeout in ms. |

## How it works

`confine()` is synchronous by contract, so it returns a wrapper argv immediately:

```text
[node, wrapper.cjs, {"argv": [...], "cwd": ..., "policy": ..., "network": ..., "timeoutMs": ...}]
```

When the consumer spawns it, the wrapper starts `runseal rpc --stdio`, sends one `execute` request, forwards the `execution.stdout` / `execution.stderr` event payloads to its own stdio, and exits with the command's exit code. Consumers see an ordinary subprocess lifecycle — no dsh core changes needed.

## Known Limitations and Deferred Work

- **stdin is not streamed** — RunSeal's `execute` accepts `stdin: { mode: 'bytes' | 'file' }`, not an interactive stream. The wrapper drains consumer stdin; long-lived interactive commands (REPLs) are not supported yet.
- **Windows setup required for confined modes** — `read-only` / `workspace-write` need `runseal setup windows-sandbox` once; until then those modes fail closed.
- **Single provider at a time** — `ctx.sandbox` accepts one provider; switching from `sandbox-local` requires disabling its row (the patch above does this).
- **No fallback chain** — unlike `sandbox-local` (bwrap→Landlock→Seatbelt→ACL), this provider does not chain to other runners; runseal must be usable or the call fails closed.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest (protocol + confine unit tests)
pnpm lint        # oxlint
pnpm build       # tsc + copies wrapper.cjs into lib/
```

## License

MIT
