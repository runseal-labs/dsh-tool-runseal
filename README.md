# dsh-tool-runseal

English | [中文](README.zh.md)

A standalone [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: replaces the built-in sandbox with [RunSeal](https://github.com/runseal-labs/runseal) — an OS-native, policy-governed execution environment with enforceable filesystem, process, resource, and network boundaries, plus structured audit events and environment-credential scrubbing.

Fully out-of-tree: depends only on published dsh base packages. Registers both `ctx.sandbox` and `ctx.subprocess`. Confined calls retain their file policy; ordinary subprocess calls run through RunSeal with explicit `danger-full-access`.

## Compatibility

Adapted against unmodified dsh `master` at `687f282e8625c6b8d11ff58211a90524be2e4317` (published packages `0.2.1-rc.2`). Automatic installation requires RunSeal **0.2.1**, including the RFC-0022 transport and terminal identity changes from `ee871b0`. Earlier local acceptance used that commit while its binary still reported `0.2.0`; the actual `v0.2.0` release tag points to `8c18b10` and lacks those changes. RunSeal uses `main`, not `master`.

## What it provides

| Item | Description |
|---|---|
| `ctx.sandbox` provider | Subclasses `SandboxProvider`; `confine()` wraps argv through a thin Node wrapper that runs the command under `runseal rpc` |
| `ctx.subprocess` provider | Owns RPC execution, streaming input, collected output/spill files, cancellation and cleanup completion |
| Policy mapping | dsh `read-only` / `workspace-write` → corresponding RunSeal sandbox levels; preserve the caller cwd separately from writable workspace roots |
| Network modes | `unmanaged` (default), `disabled`, `proxy` (enterprise routing + credential redaction) |
| Streaming output | `execution.stdout` / `execution.stderr` RPC events forwarded to the consumer's stdio; exit code propagates |
| Fail closed | Missing setup or an unavailable backend rejects with `runseal: <reason>` on stderr and a non-zero exit, never silent passthrough |
| Audit | Every execution emits `execution.requested` → `policy.resolved` → `execution.finished` events and a JSONL audit record |

## Install

Install the bundle with `dsh plugin --profile web add dsh-tool-runseal`, then restart dsh and open Plugins → RunSeal. The next plugin release downloads **RunSeal 0.2.1** during npm's `postinstall`, selects the current OS and architecture, verifies the release archive's SHA-256 checksum, and installs the executable and Windows helpers together inside the package. Published plugin 0.2.0 still requires a separately installed executable. RunSeal 0.2.0 predates the native terminal/control contract and is not a supported download target.

Supported downloads: Windows, macOS and Linux on x64 or arm64. Downloads use a fixed release URL, never `latest`. Binary availability does not imply that every OS supports restricted policies. Network access to GitHub releases and enabled npm lifecycle scripts are required; installation fails with a diagnostic on download/checksum errors. For package managers that block scripts, allow this package's install script or run `npm rebuild dsh-tool-runseal` with scripts enabled. No runtime download or silent unrestricted fallback occurs.

Leave `command` empty to use the downloaded executable. A configured `command` takes precedence over `RUNSEAL_BINARY`, which takes precedence over the downloaded binary. To install offline or use a custom executable, set `RUNSEAL_SKIP_DOWNLOAD=1` during installation and configure `command`; alternatively set `RUNSEAL_BINARY` to the custom executable during installation and at runtime. An explicit PATH name such as `runseal` is preserved. Old profile overrides remain in effect until cleared. Prebuilt artifacts are published on the [RunSeal releases](https://github.com/runseal-labs/runseal/releases) page.

On Windows, confined modes (`read-only`, `workspace-write`) require the sandbox setup once:

```sh
runseal setup windows-sandbox --cwd <workspace> --elevate
```

Install the built package into the Web profile and add dsh-tool-runseal to dsh.profile.bundles in the profile package.json:

```sh
pnpm build
pnpm pack
cd ~/.dsh/profiles/web
pnpm add /absolute/path/dsh-tool-runseal-0.2.1.tgz
```

The bundle disables the upstream sandbox and subprocess providers and registers sandbox-runseal. It uses the automatically downloaded binary by default. To override it, add this to the profile cordis.patch.yml:

```yaml
- id: sandbox-runseal
  config:
    command: 'C:/path/to/runseal.exe'
```

Start dsh web normally and open Plugins → RunSeal to edit the executable, network mode, timeout, input limit, extra arguments and wrapper auto-setup. Saving uses dsh's native configuration service to persist the profile. New commands take a configuration snapshot; running commands keep their original settings. Remove any manual insertion or command-line overlay for the same component to avoid duplicate mounting or blocked UI writes.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `command` | empty (automatic) | Custom executable: absolute path or PATH name. Empty uses `RUNSEAL_BINARY` or the downloaded pinned binary. |
| `subprocess` | `true` | Register the RPC-owned subprocess provider. Set false only for sandbox-only integrations; the old Windows kill-range limitation then remains. |
| `args` | `[]` | Extra arguments before the `rpc` subcommand (no shell). |
| `networkMode` | `unmanaged` | Network policy: `unmanaged`, `disabled`, or `proxy`. |
| `maxStdinBytes` | `65536` | Maximum bytes for exported `RunsealEngine.execute()` buffered stdin; wrapper streaming is separate. |
| `timeoutMs` | `600000` | Timeout for confined calls. Ordinary subprocess calls use caller cancellation/deadlines. |
| `autoSetup` | `true` | Wrapper-only legacy integration: request Windows setup and retry a pre-admission refusal once. The subprocess provider requires setup beforehand and does not trigger UAC. |

## How it works

`confine(argv, policy, signal)` returns `Promise<ConfinedArgv>` and rejects pre-aborted requests:

```text
[node, wrapper.cjs, {"command": ..., "args": [...], "argv": [...], "cwd": ..., "policy": ..., "network": ..., "timeoutMs": ...}]
```

The subprocess provider recognizes this plugin's wrapper argv and sends its original command directly to RunSeal, without spawning the wrapper. Workspace write roots are resolved independently of the caller cwd. Plain argv uses `danger-full-access`, preserving the existing unrestricted subprocess semantics.

Each handle owns one RPC connection. `execute` returns an admission receipt; stdout/stderr arrive as events. Input uses `writeExecutionInput` / `closeExecutionInput`. `terminate()` and the caller's abort signal send `cancelExecution` on that same connection, including cancellation queued before receipt. They do not kill the RPC owner. The cancellation acknowledgment is not completion: `done` and `waitForExit()` wait for the terminal `cleanup_complete: true` and RPC owner exit. Missing cleanup proof or transport loss rejects instead of claiming the range is empty. Plugin disposal cancels all live handles and joins their cleanup.

Collected output uses dsh's public bounded-tail/spill collector. Explicit environment entries are forwarded subject to RunSeal's environment policy; keys denied by its scrub policy fail explicitly. With `subprocess: false`, other consumers still launch the standalone wrapper, retaining its existing limitations.

## Known Limitations and Deferred Work

- **Native interactive I/O** — PTY startup, input, resize and interrupt use RunSeal RPC. Control traffic uses a native byte pipe at child fd 7. Input close seals writes without peer EOF; children use message framing and close after their final response. The terminal exposes the actual child PID. Interrupt waits for native Ctrl-C input delivery and returns the Windows console root PID; shell activity remains unknown. Windows SIGTERM cancels and joins the owned console range. SIGKILL of the terminal shell is refused; SIGTSTP and SIGHUP are unsupported. Terminal termination waits for cleanup and outstanding operations.
- **Coverage** — only commands routed through `ctx.subprocess` are managed. Direct `node:child_process` users bypass the provider.
- **Existing abandoned gates** — this change prevents the normal cancellation path from killing the owner. It does not silently reset a gate left by a previous crash or force-kill. Use `runseal repair execution-gates --json` in an elevated Windows shell; repair must prove release. Hard host termination still cannot guarantee graceful cleanup.
- **Platform verification** — native integration was exercised on Windows. macOS/Linux execution and UAC setup have not been exercised by this adaptation.
- **Setup** — complete Windows setup before mounting the subprocess provider. It never performs automatic elevation.
- **Single provider per service** — the bundle disables both `sandbox` and `subprocess`.
- **No fallback chain** — unlike `sandbox-local` (bwrap→Landlock→Seatbelt→ACL), this provider does not chain to other runners; runseal must be usable or the call fails closed.

## Windows UI acceptance (2026-10-23)

Two real command flows were exercised through the dsh Web UI using unmodified dsh master (`687f282e86`), RunSeal 0.2.0 (`ee871b0`), and the plugin installed as a Web profile bundle (`3630495`):

1. Select the access mode in the UI and run a PowerShell command that prints a start marker, sleeps for 120 seconds, then prints an end marker.
2. Confirm execution has started, then cancel midway with the UI's Stop generation button.
3. Run a short marker command in the same conversation and access mode. Neither round required restarting dsh, manually repairing execution gates, or elevating permissions.

| UI mode | RunSeal policy | Cancellation result | Subsequent execution |
|---|---|---|---|
| Full access | `danger-full-access`, `sandbox.enforced: false` | Cancelled after about 12 seconds; `EXECUTION_CANCELLED`, `cleanup_complete: true` | Printed `RUNSEAL_UI_RETRY_20261023_OK`; exit code 0, cleanup complete |
| Workspace write | `workspace-write`, `sandbox.enforced: true` | Cancelled after about 9 seconds; `EXECUTION_CANCELLED`, `cleanup_complete: true` | Printed `RUNSEAL_RESTRICTED_RETRY_OK`; exit code 0, cleanup complete |

The full-access round verified the actual process chain `dsh → runseal.exe rpc → pwsh.exe`. The workspace-write audit confirmed a `restricted-local-process` boundary and `low-privilege` identity. In both rounds, the recorded RunSeal owner and command processes had exited after cancellation. Subsequent execution was checked against the UI's raw tool output and RunSeal completion records (the audit records output byte counts, not output text).

Local audit files remain under the execution workspace's `.runseal/audit/`; they are not distributed with this repository:

| Mode | Cancellation record | Subsequent execution record |
|---|---|---|
| Full access | `sess_1a165f70d4c_4fb0_0.jsonl` | `sess_1a165f762d6_125c_0.jsonl` |
| Workspace write | `sess_1a165f9a3cd_ab54_0.jsonl` | `sess_1a165f9f5da_2ca8_0.jsonl` |

These results cover cleanup and successful subsequent execution after normal UI cancellation on Windows. The full-access round does not validate sandbox isolation. The UI commands did not write files; these two rounds did not repeat filesystem-boundary tests or exercise forced host termination or other platforms.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # protocol, wrapper process, Cordis and dsh subprocess tests
pnpm lint        # oxlint
pnpm build       # tsc + copies wrapper.cjs into lib/
```

For native integration, set `RUNSEAL_TEST_BINARY` to an absolute binary path and run `pnpm test`. The opt-in test uses a temporary workspace and `autoSetup: false`; it checks cwd, streaming stdin, read-only denial, workspace write boundaries, protocol cancellation, AbortSignal, disposal, and successful re-admission afterward. Without this variable, that test is skipped.

Integration targets unmodified dsh master and its 0.2.1-rc.2 interfaces. Build RunSeal with RFC-0022 support. Set `RUNSEAL_TEST_BINARY` to the native binary and `DSH_SOURCE_ROOT` to an unmodified dsh checkout to test the upstream control helper directly. No upstream patches or protocol downgrade are used.

## License

MIT
