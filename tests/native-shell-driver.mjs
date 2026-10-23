/** Opt-in Cordis driver: mount with unmodified dsh base and the built plugin. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
export const name = 'runseal-shell-acceptance';
export const inject = ['shell', 'subprocess', 'sandbox'];
export function apply(ctx) { ctx.appReady.onReady(() => run(ctx).then(() => ctx.appExit(0), e => { console.error(e); ctx.appExit(1); })); }
async function run(ctx) {
    const root = process.env.SHELL_TEST_ROOT;
    assert(root, 'SHELL_TEST_ROOT must name an isolated acceptance workspace');
    await mkdir(root, { recursive: true });
    const win = process.platform === 'win32';
    const rows = [];
    const policy = { mode: 'workspace-write', workspaceRoot: root };
    async function command(text, p = policy) { const h = await ctx.shell.execute(ctx.shell.resolve({ command: text, workdir: root, sandboxPolicy: p, timeoutMs: 15000 })); return h.result(); }
    const ok = await command(win ? 'Write-Output "NATIVE_SHELL_OK"' : 'printf "NATIVE_SHELL_OK\\n"');
    assert.equal(ok.exitCode, 0, JSON.stringify(ok));
    assert(ok.stdout.text.includes('NATIVE_SHELL_OK'));
    rows.push({ case: 'shell', result: ok });
    const failed = await command(win ? '[Console]::Error.WriteLine("ordinary command failure"); exit 17' : 'printf "ordinary command failure\\n" >&2; exit 17');
    assert.equal(failed.exitCode, 17);
    assert.equal(failed.sandbox.denied, false);
    rows.push({ case: 'ordinary-failure', result: failed });
    const deniedPath = join(root, 'read-only-denied.txt');
    const denied = await command(win ? `[System.IO.File]::WriteAllText('${deniedPath}','denied')` : `printf denied > '${deniedPath}'`, { ...policy, mode: 'read-only' });
    assert.notEqual(denied.exitCode, 0, JSON.stringify(denied));
    assert.equal(denied.sandbox.denied, true, JSON.stringify(denied));
    await assert.rejects(access(deniedPath));
    rows.push({ case: 'read-only-denial', result: denied });
    const long = await ctx.shell.execute(ctx.shell.resolve({ command: win ? 'Write-Output "CANCEL_READY"; Start-Sleep -Seconds 120' : 'printf "CANCEL_READY\\n"; sleep 120', workdir: root, sandboxPolicy: policy, timeoutMs: 15000 }));
    const until = Date.now() + 10000;
    while (!long.observed.stdout.readFrom(0).text.includes('CANCEL_READY')) {
        if (long.exitCode !== null)
            throw Error('long command exited early');
        if (Date.now() > until)
            throw Error('readiness missing');
        await new Promise(r => setTimeout(r, 25));
    }
    long.kill();
    await long.done;
    rows.push({ case: 'cancel', result: await long.result() });
    const retry = await command(win ? 'Write-Output "NATIVE_SHELL_RETRY_OK"' : 'printf "NATIVE_SHELL_RETRY_OK\\n"');
    assert.equal(retry.exitCode, 0);
    assert(retry.stdout.text.includes('NATIVE_SHELL_RETRY_OK'));
    rows.push({ case: 'retry', result: retry });
    await writeFile(join(root, 'results.json'), JSON.stringify(rows, null, 2));
    console.log('NATIVE_SHELL_ALL_PASS');
}
