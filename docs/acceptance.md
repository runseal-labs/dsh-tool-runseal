# Acceptance records

[README](../README.md) | [中文](acceptance.zh.md)

Historical results below apply to the versions and environments stated in each section.

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

## npm 0.2.1 automatic installation and Web profile acceptance (2026-10-23)

Both `dsh-tool-runseal@0.2.1` and RunSeal `v0.2.1` were publicly released before this acceptance. In a fresh directory, `npm install dsh-tool-runseal@latest --registry=https://registry.npmjs.org --foreground-scripts --no-audit --no-fund` resolved plugin 0.2.1. Its postinstall downloaded the Windows x64 archive from the public GitHub release, verified SHA-256, and installed all three executables. No local tarball, download fixture, custom binary path, or download override was used. The installed binary reported 0.2.1. An installed-package smoke check cancelled a workspace-write command, waited for cleanup, then printed `AUTO_BINARY_RETRY_OK` with exit code 0.

The local Web profile was then installed with `dsh plugin --profile web add dsh-tool-runseal@0.2.1 --registry=https://registry.npmjs.org`. The profile allowed this package's install script and exempted this exact version from pnpm's minimum release age. The bundle was registered, `command` was cleared to an empty string, and dsh was restarted. The plugin page showed version 0.2.1, an empty executable field, and a running RunSeal component.

In the existing conversation, with **Workspace write** selected:

1. Run `Write-Output "AUTO_NPM_021_BEGIN"; Start-Sleep -Seconds 120; Write-Output "AUTO_NPM_021_END"` through the page.
2. While the command was running, verify that the dsh child process used `<web-profile>/node_modules/dsh-tool-runseal/.runseal/0.2.1-win32-x64/runseal.exe rpc --stdio`.
3. Click **Stop generation**. The page showed the stopped turn; a process check found no remaining RunSeal owner, command runner, or matching long-running command.
4. In the same conversation and mode, run `Write-Output "AUTO_NPM_021_RETRY_OK"`. The page showed successful completion and the expected output, with exit code 0. No additional restart, gate repair, or elevation was needed between cancellation and retry.

This acceptance used the public npm package and automatically downloaded release binary on an already configured Windows host. It does not establish first-time Windows setup, macOS/Linux runtime behavior, or new filesystem-isolation coverage. The Web round verified page state and process cleanup; it did not separately inspect protocol terminal audit records. Local screenshots are retained as `web-0.2.1-config.png` and `web-0.2.1-cancel-retry.png` under the acceptance output directory, outside the repository.

## Browser terminal policy and PTC follow-up (local fix, 2026-10-23)

Upstream user terminals call `spawnTerminal()` without confinement. The plugin now resolves the live session's sandbox policy for terminals carrying `DSH_SESSION_ID` and `shellActivity`, then confines restricted sessions before allocation. Missing session/policy services fail closed. Policy is captured when the terminal is created: close and recreate existing terminals after changing access mode. Anonymous subprocesses retain their existing behavior.

PTC deliberately removes child profile environment variables. The plugin pins the RPC owner's Windows sandbox setup directory independently, without restoring removed child profile variables or credentials.

The local Web profile used a patched tarball with the automatically downloaded RunSeal 0.2.1 binary; these fixes are **not in the published npm 0.2.1 package**. Against unmodified dsh, in Workspace write mode:

- Page PTY: `isTTY: true`, input echo and resize passed; closing the active terminal cancelled execution with `cleanup_complete: true`, and a new terminal printed `PTY_RESTART_OK`. Cancellation audit: `sess_1a1662d9a15_8b18_0.jsonl`.
- Native page PTC: stopped a running `run_code`, confirmed cancellation and cleanup, then ran code again and inspected raw output `PTC_CONTROL_RESTART_OK` and `{"sum":6}`. Control-channel audit records: `sess_1a16630f7c3_7f50_0.jsonl` (cancel) and `sess_1a166329a06_a0e0_0.jsonl` (retry). Both recorded enforced workspace-write. The successful code result travels over the control channel; dsh subsequently terminates the worker, so its process audit records cancellation and completed cleanup rather than exit code 0.

Ctrl-C was subsequently verified with real keyboard input in the page. Browser automation's Ctrl-C shortcut did not generate terminal input; temporary plugin diagnostics recorded no ETX for those attempts. With the user pressing Ctrl-C, a raw-mode probe printed `BYTES:03` and `RAW_CTRL_C_OK`, and a normal Node process handled SIGINT, printed `PAGE_SIGINT_OK`, and exited back to the same shell. A subsequent command printed `PAGE_CTRL_C_RESTART_OK`. The plugin recorded both ETX bytes; audit `sess_1a166385259_a450_0.jsonl` confirmed enforced workspace-write and completed cleanup after closing the terminal. No Ctrl-C translation change was needed; a regression assertion preserves ETX as ordinary PTY input so raw-mode applications retain their semantics.

During diagnosis, restarting dsh with a live test terminal left execution-gate reservations. After explicit authorization, the official elevated repair cleared two reservations and one runtime root; it reported zero uninspectable processes and no unverified runtime roots. The final terminal was closed normally and cleanup was confirmed before restarting dsh. Temporary diagnostics were removed. This does not establish forced-host-termination recovery without repair. No new filesystem-boundary or other-platform coverage is claimed.

## npm 0.2.2 installation and Web acceptance (2026-10-23)

Plugin 0.2.2 was published from `8c1bf2ef35bad01467e208003eb120424a676753`, with RunSeal pinned to 0.2.1. The public npm registry reported `latest: 0.2.2`; its tarball integrity matched the locally packed and verified artifact:

```text
sha512-wLsKIBesiTEmGlZdsWsJY/g423d1t9fbMR8Xz3Jp7vrwujN8Or4sLNNnWSyhJ9U3Kq+ylhU+yRazl8Qp929FVA==
```

In a fresh directory, `npm install dsh-tool-runseal@0.2.2 --registry=https://registry.npmjs.org --foreground-scripts --no-audit --no-fund` installed the public package and automatically downloaded RunSeal 0.2.1 and its Windows helpers. No local tarball or custom binary override was used. Running the installed package in workspace-write mode passed a 98,304-byte fd 7 control-channel round trip, cancellation with cleanup and retry, plus PTY input, resize, interrupt, cancellation and restart (`PUBLIC_NPM_022_ALL_PASS`).

The Web profile was upgraded using `dsh plugin --profile web add dsh-tool-runseal@0.2.2 --registry=https://registry.npmjs.org`, replacing its local tarball dependency. This exact version was exempted from the profile's minimum release age, and the package's install script was allowed. After restarting unmodified dsh, the plugin page showed 0.2.2, an empty custom executable field and a running component. The observed process used the profile package's `.runseal/0.2.1-win32-x64/runseal.exe rpc --stdio`.

With **Workspace write** selected, the page checks were:

| Path | Interaction and cancellation | Subsequent execution |
|---|---|---|
| PTY | Printed `NPM_022_PTY_READY:true` and `PTY_ECHO:npm022`; closing the running terminal recorded `EXECUTION_CANCELLED` and completed cleanup | A new terminal printed `NPM_022_PTY_RESTART_OK:true`; normal shell exit recorded exit code 0 and completed cleanup |
| PTC | Stopped a running native `run_code` through **Stop generation**; control traffic and completed cancellation cleanup were recorded | Raw tool output showed `NPM_022_PTC_RETRY_OK` and `42`; worker teardown completed cleanup |

All four audits recorded `workspace-write` with `sandbox.enforced: true`:

| Path | Cancellation audit | Retry audit |
|---|---|---|
| PTY | `sess_1a166439724_8d18_0.jsonl` | `sess_1a1664434c5_83b0_0.jsonl` |
| PTC | `sess_1a166435b69_93c0_0.jsonl` | `sess_1a166439a94_947c_0.jsonl` |

As in the earlier PTC check, successful code output precedes dsh's worker cancellation, so the retry's process audit reports cancellation rather than exit code 0. No restart, repair or elevation was needed between cancellation and retry. The final test terminal exited normally, and no RunSeal owner or command runner remained. Screenshots `web-npm-0.2.2-config.png`, `web-npm-0.2.2-interaction.png` and `web-npm-0.2.2-restart.png`, plus native results and audits, are retained locally outside this repository. This round used an already configured Windows host; it did not repeat manual page Ctrl-C, first-time setup, filesystem-boundary or other-platform validation.

## Windows host-exit cleanup (0.2.3)

The RPC owner now starts detached from the Windows host console, with its window hidden and its stdio pipes still connected. It is not unreferenced: normal disposal still waits for owner exit. If the plugin host exits or is killed, pipe closure lets RunSeal cancel its executions, finish native cleanup and release its reservations without invoking repair. Previously, a host-exit probe lost the owner before a cleanup terminal record was written.

Native fault-injection tests against RunSeal 0.2.1 cover both immediate host exit without disposal and forced host termination. Both confirm enforced workspace-write, `client_disconnected`, `cleanup_complete: true`, and a subsequent restricted execution without repair. Plugin 0.2.3 includes this change and continues to pin RunSeal 0.2.1.

This prevents ordinary host loss from interrupting cleanup; it does not automatically unlock existing stale records. Killing the owner as well, terminating its entire OS job, power loss, or an unprovable cleanup still requires strict native repair. The plugin never deletes gate records, treats PID absence as cleanup proof, or automatically uses `--accept-unverified-release`.

## npm 0.2.3 and real Web host loss (2026-10-23)

Published from `03240acc31a0ee91240aa0f952ecb5851313b69d`; public npm `latest` resolved to 0.2.3 and its integrity matched the verified tarball. A fresh ordinary npm install downloaded pinned RunSeal 0.2.1. The Web profile was upgraded from the public registry, with no custom executable path. The plugin page showed 0.2.3 and a running component.

A page terminal in workspace-write printed `NPM_023_HOST_LOSS_READY` while a Node child stayed active. Only the dsh host was forcibly stopped. Audit `sess_1a166509e64_95fc_0.jsonl` recorded `client_disconnected`, `sandbox.enforced: true`, and `cleanup_complete: true`; owner and runner exited. After restarting unmodified dsh, a new page terminal printed `NPM_023_AFTER_HOST_RESTART_OK true`. Audit `sess_1a16651d62c_b0bc_0.jsonl` recorded enforced workspace-write, exit code 0 and complete cleanup after normal terminal exit. No repair, elevation or gate deletion occurred between attempts.

Typecheck, lint, build and 30 focused tests passed, including two native host-loss tests. This Windows test kills the host only; it does not cover killing the owner, an entire OS job or machine power loss. Local screenshot: `web-npm-0.2.3-restart.png` (outside the repository).

## macOS arm64 (mba) native acceptance (2026-10-23)

Environment: mba (Darwin arm64), installed dsh desktop release **0.2.1-rc.2**, npm plugin **0.2.3**, and automatically downloaded **RunSeal 0.2.1 darwin-arm64**. Over SSH, the distribution's own dsh launcher booted an isolated `runseal-acceptance-023` profile using the original dsh base bundle and the plugin installed in the desktop profile. The acceptance driver executed real commands through `ctx.sandbox.confine()` and `ctx.subprocess`. No dsh source or installation files were changed; the desktop profile and active desktop session were left untouched.

| Scenario | Observed result |
|---|---|
| Workspace-write | Writing inside the workspace succeeded; writing to the outside test path was denied and no target file existed. |
| Read-only | Writing inside the workspace was denied and no target file existed. |
| Cancellation and retry | After a long-running command reported ready, `terminate()` was followed by `done` and `waitForExit()`. The audit recorded cancellation and complete cleanup; the next restricted command printed `MBA_DSH_RETRY_OK` and exited 0. |
| Unexpected dsh exit | After readiness, SIGKILL targeted only the isolated profile's dsh host. RunSeal recorded client_disconnected and complete cleanup. |
| Execution after restart | Restarting the same launcher and acceptance profile passed the file-boundary, cancellation and retry checks again. |

Key audit records:

- Initial cancellation: `sess_1a1665562c2_403c_0.jsonl`; retry: `sess_1a166556368_403e_0.jsonl`.
- Host kill: `sess_1a16655a1f2_4054_0.jsonl`, with `termination_reason: client_disconnected`.
- Cancellation after restart: `sess_1a16655a6c5_4060_0.jsonl`; retry: `sess_1a16655a76b_4063_0.jsonl`.

These audits all recorded `sandbox.enforced: true` and `cleanup_complete: true`, with workspace-write or read-only as applicable. No RunSeal processes or execution directories under the workspace's `.runseal/runtime` remained. No repair, gate deletion or elevation was used. Scripts and evidence remain under `~/.dsh/runseal-acceptance-023/` on mba; a results copy is retained at `~/.dsh/runseal-preview/mba-0.2.3/results.json` on Windows.

**The macOS native execution paths above are verified working.** RunSeal 0.2.1 still reports backend `runseal-macos-experimental` and status `experimental`; plugin acceptance does not change that upstream support classification. This does not claim validation of macOS UI interaction, PTY/PTC, other architectures, killing the owner itself or an entire process group, or power loss.
