// Test-only, on a throwaway branch. Runs the memory check's Windows hook the
// way a Claude worker would in the PACKAGED app: scripts/memory-gate-hook.cmd
// from app.asar.unpacked starts the packaged Agentbox.exe as a node on
// main/memory-gate-hook.mts inside app.asar, against a real coordinator on the
// local channel. No Claude Code, no account, no secrets.
//
//   node memory-hook-packaged.mjs <Agentbox.exe> <resources folder>
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryGateServer } from '../../main/memory-gate-server.mts';
import { CommandHistory } from '../../main/memory-gate-history.mts';

setTimeout(() => { console.log('FAIL: the whole run took over 10 minutes'); process.exit(1); }, 10 * 60_000).unref();

const [exe, resourcesGiven] = process.argv.slice(2);
const resources = path.resolve(resourcesGiven);
const cmd = path.join(resources, 'app.asar.unpacked', 'scripts', 'memory-gate-hook.cmd');
const hook = path.join(resources, 'app.asar', 'main', 'memory-gate-hook.mts');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`); if (!ok) failures.push(what); };

console.log('exe:', exe);
check(fs.existsSync(cmd), `the .cmd is unpacked at ${cmd}`);
check(fs.existsSync(path.join(resources, 'app.asar')), 'app.asar is there');

// What the packaged binary says as a node: its Node and whether it strips types itself.
const about = JSON.parse(execFileSync(exe, ['-p', 'JSON.stringify({ node: process.versions.node, electron: process.versions.electron, typescript: process.features.typescript ?? null })'],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 }).trim());
console.log('packaged binary as a node:', JSON.stringify(about));
// main/strip-types.mts: no flags when it strips on its own, else the two.
const flags = about.typescript ? '' : '--experimental-strip-types --disable-warning=ExperimentalWarning';
console.log('flags the app would hand the hook:', JSON.stringify(flags));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-packaged-'));
const history = new CommandHistory();
for (let i = 0; i < 3; i++) history.record('git status', { peakMb: 10, durationMs: 100 });
const server = new MemoryGateServer({
  socketPath: path.join(dir, 'g.sock'),
  channel: { dir: path.join(dir, 'channels'), stamp: 'try' },
  history,
  readPressure: async () => ({ level: null, freePct: 50 }),
  sampleProcesses: async () => [],
  pollMs: 50,
  lockPort: 0,
  gate: { slots: 1 },
});
check((await server.start()) === 'owner', 'the coordinator serves the local channel');

function run(mode, { id = 't1', command = 'git status', shell = true, ps = null } = {}) {
  const input = JSON.stringify({ session_id: 's1', hook_event_name: mode === 'pre' ? 'PreToolUse' : 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command }, duration_ms: 1200 });
  const [file, args] = ps ? [ps.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps.line(mode)]] : [`"${cmd}" ${mode}`, []];
  const child = spawn(file, args, {
    shell: ps ? false : shell, windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
      LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP,
      AGENTBOX_GATE_CHANNEL: path.join(dir, 'channels'), AGENTBOX_GATE_STAMP: 'try',
      AGENTBOX_GATE_RUNTIME: exe, AGENTBOX_GATE_FLAGS: flags, AGENTBOX_GATE_HOOK: hook,
      AGENTBOX_GATE_ITEM: 'w-try', AGENTBOX_GATE_PRODUCT: 'demo', AGENTBOX_GATE_SCORE: '5', AGENTBOX_GATE_RETRY_S: '0.1',
    },
  });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const started = performance.now();
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err, ms: Math.round(performance.now() - started) })));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  return { child, done };
}
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);

// 1. It loads from inside app.asar and reaches the coordinator.
const before = server.status().counts.asked;
const first = await within(run('pre').done, 30_000);
console.log('first light check:', JSON.stringify(first));
check(first !== 'timeout' && first.code === 0 && first.out === '' && first.err === '', 'a light command is let through, with nothing on stderr');
check(server.status().counts.asked === before + 1, 'the hook inside app.asar reached the coordinator');
await within(run('post').done, 30_000);

// 2. It holds a second heavy command until the first reports back.
await within(run('pre', { id: 'h1', command: 'npm test' }).done, 30_000);
const second = run('pre', { id: 'h2', command: 'cargo build' });
check((await within(second.done, 3_000)) === 'timeout', 'a second heavy command waits while the first runs');
await within(run('post', { id: 'h1', command: 'npm test' }).done, 30_000);
const freed = await within(second.done, 30_000);
check(freed !== 'timeout' && freed.code === 0, 'it goes once the first reports back');
await within(run('post', { id: 'h2', command: 'cargo build' }).done, 30_000);

// 3. What one check costs, and how much of that is the binary starting.
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.9)]; };
const startOnly = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  execFileSync(exe, ['-e', '0'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 });
  startOnly.push(Math.round(performance.now() - t));
}
for (const [name, shell] of [['cmd.exe', true], ['Git Bash', fs.existsSync(gitBash) ? gitBash : null]]) {
  if (!shell) { console.log(`(no ${name} here)`); continue; }
  const pre = []; const post = [];
  for (let i = 0; i < 20; i++) {
    const a = await within(run('pre', { id: `m${i}`, shell }).done, 30_000);
    const b = await within(run('post', { id: `m${i}`, shell }).done, 30_000);
    if (a === 'timeout' || b === 'timeout' || a.err || a.out) { check(false, `${name} run ${i}: ${JSON.stringify(a)}`); break; }
    pre.push(a.ms); post.push(b.ms);
  }
  if (pre.length) console.log(`${name}: before a command median ${median(pre)} ms, p90 ${p90(pre)} ms; after median ${median(post)} ms (${pre.length} runs)`);
}
// 4. Through PowerShell, which Claude Code uses for hooks without Git Bash or
// with "shell": "powershell". Claude Code's own spawn line is not published;
// this is -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <line>.
const shells = [['powershell.exe', 'powershell.exe'], ['pwsh', 'pwsh.exe']];
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
const probe = path.join(probeDir, 'probe.cmd');
fs.writeFileSync(probe, '@echo off\r\nfindstr "^" > "%~dp0in.txt"\r\necho args=%*> "%~dp0args.txt"\r\nset AGENTBOX_ > "%~dp0env.txt" 2>&1\r\nexit /b 0\r\n');
for (const [shellName, exePs] of shells) {
  for (const [lineName, line] of Object.entries({ plain: (m) => `& "${probe}" ${m}`, piped: (m) => `$input | & "${probe}" ${m}` })) {
    for (const f of ['in.txt', 'args.txt', 'env.txt']) fs.rmSync(path.join(probeDir, f), { force: true });
    const r = spawnSync(exePs, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', line('pre')],
      { input: '{"tool_input":{"command":"git status"}}', encoding: 'utf8', timeout: 30_000, env: { ...process.env, AGENTBOX_PROBE: 'yes' } });
    const read = (f) => { try { return fs.readFileSync(path.join(probeDir, f), 'utf8').trim(); } catch { return '(none)'; } };
    console.log(`probe ${shellName} ${lineName}: exit ${r.status} stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify((r.stderr || '').slice(0, 300))} | stdin seen ${JSON.stringify(read('in.txt'))} | ${read('args.txt')} | env ${JSON.stringify(read('env.txt'))}`);
  }
}
const lines = {
  'plain "& path"': (mode) => `& "${cmd}" ${mode}`,
  '"$input | & path"': (mode) => `$input | & "${cmd}" ${mode}`,
};
for (const [shellName, exePs] of shells) {
  for (const [lineName, line] of Object.entries(lines)) {
    const ps = { exe: exePs, line };
    const asked = server.status().counts.asked;
    const a = await within(run('pre', { id: `ps-${shellName}-${lineName}`, ps }).done, 30_000);
    const reached = server.status().counts.asked === asked + 1;
    await within(run('post', { id: `ps-${shellName}-${lineName}`, ps }).done, 30_000);
    console.log(`${shellName} ${lineName}: ${JSON.stringify(a)} reached coordinator: ${reached}`);
    if (!reached) continue;
    // Does it hold, and what does it cost?
    await within(run('pre', { id: 'ph1', command: 'npm test', ps }).done, 30_000);
    const held = run('pre', { id: 'ph2', command: 'cargo build', ps });
    const waited = (await within(held.done, 3_000)) === 'timeout';
    await within(run('post', { id: 'ph1', command: 'npm test', ps }).done, 30_000);
    const went = await within(held.done, 30_000);
    await within(run('post', { id: 'ph2', command: 'cargo build', ps }).done, 30_000);
    const times = [];
    for (let i = 0; i < 10; i++) {
      const t = await within(run('pre', { id: `pm${i}`, ps }).done, 30_000);
      await within(run('post', { id: `pm${i}`, ps }).done, 30_000);
      if (t !== 'timeout') times.push(t.ms);
    }
    console.log(`  ${shellName} ${lineName}: holds a second heavy command: ${waited && went !== 'timeout'}; before a command median ${median(times)} ms, p90 ${p90(times)} ms`);
  }
}
const psStart = [];
for (let i = 0; i < 5; i++) { const t = performance.now(); execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 30_000 }); psStart.push(Math.round(performance.now() - t)); }
console.log(`powershell.exe starting and doing nothing: median ${median(psStart)} ms`);

console.log(`the packaged binary starting as a node and doing nothing: median ${median(startOnly)} ms, p90 ${p90(startOnly)} ms`);

await server.stop();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
