import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
export const name = 'desktop-ptc-acceptance';
export const inject = ['ptcRuntime', 'subprocess'];
export function apply(ctx) { ctx.appReady.onReady(() => run(ctx).then(() => ctx.appExit(0), e => { console.error(e); ctx.appExit(1); })); }
async function run(ctx) {
    const root = process.env.DESKTOP_PTC_ROOT;
    assert(root, 'DESKTOP_PTC_ROOT must name an isolated workspace');
    await mkdir(root, { recursive: true });
    const policy = { mode: 'workspace-write', workspaceRoot: root };
    const runtime = ctx.ptcRuntime;
    const request = (program, bindings = [], signal) => runtime.run(runtime.resolve({ program, bindings, cwd: root, sandboxPolicy: policy, ...signal ? { signal } : {} }));
    const first = await request('const v=await tools.echo({answer:42});await tools.identity({node:process.execPath,electron:process.versions.electron??null});const big="交互".repeat(49152);if(await tools.roundtrip({big})!==big)throw Error("control mismatch");console.log("DESKTOP_PTC_INTERACTION_OK");return v;', [{ global: 'tools', functions: { echo: async (args) => args, identity: async (args) => { assert.equal(args.electron, null); assert(args.node.toLowerCase().endsWith("node.exe")); await writeFile(root + "/worker-identity.json", JSON.stringify(args)); return null; }, roundtrip: async (args) => args.big } }]);
    assert.equal(first.error, undefined, JSON.stringify(first));
    assert.deepEqual(first.value, { answer: 42 });
    console.log('DESKTOP_PTC_INTERACTION_OK');
    const entered = Promise.withResolvers();
    const controller = new AbortController();
    const active = request('await tools.ready({pid:process.pid});await new Promise(()=>{});', [{ global: 'tools', functions: { ready: async (info) => { entered.resolve(info); return null; } } }], controller.signal);
    const info = await entered.promise;
    assert(Number.isSafeInteger(info.pid));
    controller.abort('acceptance cancel');
    const cancelled = await active;
    assert.equal(cancelled.error.kind, 'abort', JSON.stringify(cancelled));
    console.log('DESKTOP_PTC_CANCELLED');
    const retry = await request('console.log("DESKTOP_PTC_RETRY_OK");return 43;');
    assert.equal(retry.error, undefined, JSON.stringify(retry));
    assert.equal(retry.value, 43);
    console.log('DESKTOP_PTC_RETRY_OK');
    await writeFile(root + '/results.json', JSON.stringify({ host: process.pid, execPath: process.execPath, first, cancelled, retry }, null, 2));
    if (process.env.DESKTOP_PTC_CASE === 'host-loss') {
        await request('const {spawn}=await import("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});await tools.ready({worker:process.pid,descendant:child.pid});await new Promise(()=>{});', [{ global: 'tools', functions: { ready: async (info) => { await writeFile(root + '/host-loss-ready.json', JSON.stringify({ host: process.pid, ...info })); console.log('DESKTOP_HOST_LOSS_READY'); return null; } } }]);
        throw Error('host-loss execution unexpectedly ended');
    }
    console.log('DESKTOP_PTC_ALL_PASS');
}
