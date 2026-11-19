// ON WINDOWS A CLAUDE WORKER'S COMMANDS ASK THE MEMORY CHECK OVER THE APP'S OWN CHANNEL.
//
// The coordinator listened on a socket file, which fails with EACCES on
// Windows 11 (Node 24.11), and the hook Claude workers carried was a
// single-quoted .sh path that asks over that socket with curl, so no command
// ever waited. The coordinator now serves the local channel
// (main/local-channel.mts) on the same HTTP routes, and a Claude worker's hook
// is scripts/memory-gate-hook.cmd, which runs main/memory-gate-hook.mts on the
// app's own binary as a node. Codex is still left out on Windows
// (tests/on-windows-no-codex-hook-is-written-into-anyones-codex-home).
//
// Measured on Windows 11 with Node 24.11: the .cmd, started by a double-quoted
// path through cmd.exe and through Git Bash, gets its stdin and prints to
// stdout, and the runs below go over a real named pipe. The Mac and Linux
// shapes are pinned here on every platform.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryGateServer, gateChannel, CHANNEL_KIND } from '../main/memory-gate-server.mts';
import { GATE_KIND, hookBody } from '../main/memory-gate-hook.mts';
import { CommandHistory } from '../main/memory-gate-history.mts';
import { DEFAULTS as GATE } from '../main/memory-gate.mts';
import { stripTypesFlags } from '../main/strip-types.mts';
import { Supervisor } from '../main/supervisor.mts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHIM = path.join(root, 'scripts', 'memory-gate-hook.cmd');
const HOOK = path.join(root, 'main', 'memory-gate-hook.mts');
const onWindows = process.platform === 'win32';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

const dirs: string[] = [];
const servers: MemoryGateServer[] = [];
const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const s of sups.splice(0)) await s.stopMemoryGate();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-win-'));
  dirs.push(d);
  return d;
}

describe('where the coordinator listens', () => {
  it('is the socket on macOS and Linux, with no channel', () => {
    expect(gateChannel('/tmp/agentbox-memory-gate.sock', { platform: 'darwin' })).toBe(null);
    expect(gateChannel('/tmp/agentbox-memory-gate.sock', { platform: 'linux' })).toBe(null);
  });

  it('is the channel in the account\'s own folder on Windows, one stamp per socket path', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\ann\\AppData\\Local' };
    const a = gateChannel('C:\\Users\\ann\\AppData\\Local\\Temp\\agentbox-memory-gate.sock', { platform: 'win32', env, home: 'C:\\Users\\ann' });
    expect(a).toEqual({ dir: 'C:\\Users\\ann\\AppData\\Local\\agentbox\\channels', stamp: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const again = gateChannel('C:\\Users\\ann\\AppData\\Local\\Temp\\agentbox-memory-gate.sock', { platform: 'win32', env, home: 'C:\\Users\\ann' });
    expect(again).toEqual(a);
    const other = gateChannel('C:\\elsewhere\\g.sock', { platform: 'win32', env, home: 'C:\\Users\\ann' });
    expect(other && 'stamp' in other ? other.stamp : null).not.toBe(a && 'stamp' in a ? a.stamp : null);
  });

  it('is nowhere on Windows when the folder is on a network share, and the coordinator does not start', async () => {
    const channel = gateChannel('C:\\x\\g.sock', { platform: 'win32', env: { LOCALAPPDATA: '\\\\server\\share' }, home: 'C:\\Users\\ann' });
    expect(channel).toEqual({ dir: null, problem: expect.stringMatching(/not on a local drive/) });
    const said: string[] = [];
    const server = new MemoryGateServer({ channel, platform: 'win32', lockPort: 0, readPressure: async () => ({}), log: (l) => said.push(l) });
    servers.push(server);
    expect(await server.start()).toBe('stopped');
    expect(said.join('\n')).toMatch(/not started/);
  });

  it('the hook and the coordinator name the same kind of channel', () => {
    expect(GATE_KIND).toBe(CHANNEL_KIND);
  });
});

describe('a grant nobody can measure', () => {
  function granted(platform: NodeJS.Platform) {
    let now = 1_000_000;
    const server = new MemoryGateServer({ platform, lockPort: 0, readPressure: async () => ({}), clock: () => now });
    server.gate.submit({ id: 'a', command: 'npm test' }, () => {});
    server.grants.set('a', { id: 'a', ppid: 1, anchor: null, anchorArgs: null, baseline: new Set(), wallStart: now, startedAt: now, ambiguous: false, emptySince: null });
    return { server, later: (ms: number) => { now += ms; } };
  }

  it('on Windows, where no process is listed, is let go after the longest wait', () => {
    const { server, later } = granted('win32');
    later(GATE.maxWaitMs - 1);
    server._sample([]);
    expect(server.gate.running.has('a')).toBe(true);
    later(1);
    server._sample([]);
    expect(server.gate.running.has('a')).toBe(false);
  });

  it('on a Mac keeps its slot as before, until its agent is seen or the three hours run out', () => {
    const { server, later } = granted('darwin');
    later(GATE.maxWaitMs + 60_000);
    server._sample([]);
    expect(server.gate.running.has('a')).toBe(true);
  });

  it('on Windows lists no processes, so it starts no ps', async () => {
    const server = new MemoryGateServer({ platform: 'win32', lockPort: 0, readPressure: async () => ({}) });
    expect(await server.sampleProcesses()).toEqual([]);
  });
});

describe('the request the Windows hook sends', () => {
  it('is the shell script\'s, field for field', () => {
    const env = { AGENTBOX_GATE_ITEM: 'w-1"x', AGENTBOX_GATE_PRODUCT: 'demo', AGENTBOX_GATE_SCORE: '7' };
    expect(hookBody('pre', '{"tool_use_id":"t"}\n', env, 42))
      .toBe('{"v":1,"event":"pre","item":"w-1x","product":"demo","score":7,"ppid":42,"hook":{"tool_use_id":"t"}}');
  });

  it('reads a score that is not a number as zero, and no payload as null', () => {
    expect(hookBody('post', '', { AGENTBOX_GATE_SCORE: '3; rm' }, 1)).toBe('{"v":1,"event":"post","item":"","product":"","score":0,"ppid":1,"hook":null}');
  });
});

function makeSupervisor(memoryGate: boolean) {
  const tmp = tmpDir();
  const store = { listItems: () => [], listProducts: () => [], isDue: () => true, readItem: () => null };
  const sup = new Supervisor({ storeRoot: tmp, home: tmp, codexHome: path.join(tmp, '.codex'), memoryGate, memoryGateSocket: path.join(tmp, 'g.sock'), memoryGateLockPort: 0 } as never, store as never, root, tmp, tmp);
  sups.push(sup);
  // The channel's folder is the account's own under %LOCALAPPDATA%; a test keeps its own.
  const channel = { dir: path.join(tmp, 'channels'), stamp: 'sup' };
  sup._memoryGateChannel = (platform = process.platform) => (platform === 'win32' ? channel : null);
  return sup;
}
const item = { id: 'w-1', product: 'demo', priority: 7 } as never;

describe('what a Claude worker carries', () => {
  it('on macOS and Linux is the .sh hook and the socket, exactly as before', () => {
    const sup = makeSupervisor(true);
    const sh = `'${path.join(root, 'scripts', 'memory-gate-hook.sh')}'`;
    const timeout = Math.ceil(GATE.maxWaitMs / 1000) + 600;
    for (const platform of ['darwin', 'linux'] as const) {
      expect(sup.memoryGateHooks(platform)).toEqual({
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${sh} pre`, timeout }] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${sh} post`, timeout: 10 }] }],
        PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${sh} post`, timeout: 10 }] }],
      });
      const env = sup.memoryGateEnv(item, platform);
      expect(Object.keys(env)).toEqual(['AGENTBOX_GATE_SOCK', 'AGENTBOX_GATE_ITEM', 'AGENTBOX_GATE_PRODUCT', 'AGENTBOX_GATE_SCORE']);
      expect(env.AGENTBOX_GATE_SOCK).toBe(path.join(sup.config.memoryGateSocket as string));
    }
  });

  it('carries nothing on any platform with the switch off', () => {
    const sup = makeSupervisor(false);
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(sup.memoryGateHooks(platform)).toBe(null);
      expect(sup.memoryGateEnv(item, platform)).toEqual({});
    }
  });

  it.runIf(onWindows)('on Windows is the .cmd hook, double-quoted, with the same events and limits', () => {
    const hooks = makeSupervisor(true).memoryGateHooks('win32')!;
    const timeout = Math.ceil(GATE.maxWaitMs / 1000) + 600;
    expect(hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${SHIM}" pre`, timeout }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${SHIM}" post`, timeout: 10 }] }],
      PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${SHIM}" post`, timeout: 10 }] }],
    });
  });

  it.runIf(onWindows)('on Windows is told the channel, the app\'s binary and the hook file, and no socket', () => {
    const sup = makeSupervisor(true);
    const env = sup.memoryGateEnv(item, 'win32') as Record<string, string>;
    expect(env).toEqual({
      AGENTBOX_GATE_CHANNEL: path.join(path.dirname(sup.config.memoryGateSocket as string), 'channels'),
      AGENTBOX_GATE_STAMP: 'sup',
      AGENTBOX_GATE_RUNTIME: process.execPath,
      AGENTBOX_GATE_FLAGS: stripTypesFlags().join(' '),
      AGENTBOX_GATE_HOOK: HOOK,
      AGENTBOX_GATE_ITEM: 'w-1',
      AGENTBOX_GATE_PRODUCT: 'demo',
      AGENTBOX_GATE_SCORE: expect.stringMatching(/^\d+$/),
    });
    // Only the .cmd makes the binary a node, so a worker's own commands never inherit that.
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it.runIf(onWindows)('on Windows the per-run settings file carries the .cmd hook, not the .sh', () => {
    const sup = makeSupervisor(true);
    const file = sup.writeWorkerSettings(null, `t-${Math.random()}`)!;
    const text = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    expect(text).toContain('memory-gate-hook.cmd');
    expect(text).not.toContain('memory-gate-hook.sh');
  });

  it('on Windows gives an app folder cmd.exe would read as syntax no hook and no hook settings', () => {
    for (const odd of ['Rock & Roll', 'a|b', 'a^b', '100%', 'wow!', 'a<b']) {
      const sup = makeSupervisor(true);
      sup.appDir = path.join(path.parse(root).root, odd, 'agentbox');
      expect(sup.memoryGateHooks('win32'), odd).toBeNull();
      expect(sup.memoryGateEnv(item, 'win32'), odd).toEqual({});
    }
    // A plain folder with a space still gets it.
    const plain = makeSupervisor(true);
    plain.appDir = path.join(path.parse(root).root, 'Program Files', 'agentbox');
    expect(plain.memoryGateEnv(item, 'win32')).toHaveProperty('AGENTBOX_GATE_HOOK');
  });
});

describe('the .cmd the packaged app ships', () => {
  it('is in the build, unpacked, because Claude Code runs it as a file', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const list of [pkg.files, pkg.build.files, pkg.build.asarUnpack]) {
      expect(list).toContain('scripts/memory-gate-hook.cmd');
      expect(list).toContain('scripts/memory-gate-hook.sh');
    }
  });

  it('never fails the command, and a ! in a path stays a !', () => {
    const text = fs.readFileSync(SHIM, 'utf8');
    expect(text).toMatch(/^setlocal DisableDelayedExpansion\r$/m);
    expect(text.trimEnd().split('\r\n').at(-1)).toBe('exit /b 0');
  });

  it('has CRLF line ends and makes the binary a node only for itself', () => {
    const text = fs.readFileSync(SHIM, 'utf8');
    expect(text.split('\r\n').slice(0, -1).every((line) => !line.includes('\n'))).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.indexOf('setlocal')).toBeLessThan(text.indexOf('set ELECTRON_RUN_AS_NODE=1'));
    expect(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8')).toMatch(/^\*\.cmd text eol=crlf$/m);
  });
});

// The rest runs the real .cmd and hook against a real coordinator on a named pipe.
async function makeServer(dir: string, gate: Record<string, number> = {}, sharedGrantMs: number | null = null) {
  const history = new CommandHistory();
  for (let i = 0; i < 3; i++) history.record('git status', { peakMb: 10, durationMs: 100 });
  const server = new MemoryGateServer({
    socketPath: path.join(dir, 'g.sock'),
    channel: { dir: path.join(dir, 'channels'), stamp: 'test' },
    history,
    readPressure: async () => ({ level: null, freePct: 50 }),
    sampleProcesses: async () => [],
    pollMs: 50,
    lockPort: 0,
    gate: { slots: 1, ...gate },
    sharedGrantMs,
  });
  servers.push(server);
  expect(await server.start()).toBe('owner');
  return server;
}

function runShim(dir: string, mode: string, { id = 't1', command = 'npm test', shell = true as boolean | string } = {}) {
  const input = JSON.stringify({
    session_id: 's1', hook_event_name: mode === 'pre' ? 'PreToolUse' : 'PostToolUse', tool_name: 'Bash',
    tool_use_id: id, tool_input: { command }, duration_ms: 1200,
  });
  const child = spawn(`"${SHIM}" ${mode}`, {
    shell,
    windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
      LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP,
      AGENTBOX_GATE_CHANNEL: path.join(dir, 'channels'), AGENTBOX_GATE_STAMP: 'test',
      AGENTBOX_GATE_RUNTIME: process.execPath, AGENTBOX_GATE_FLAGS: stripTypesFlags().join(' '), AGENTBOX_GATE_HOOK: HOOK,
      AGENTBOX_GATE_ITEM: 'w-test', AGENTBOX_GATE_PRODUCT: 'demo', AGENTBOX_GATE_SCORE: '5', AGENTBOX_GATE_RETRY_S: '0.1',
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const started = Date.now();
  const done = new Promise<{ code: number | null; out: string; err: string; ms: number }>((resolve) => child.on('close', (code) => resolve({ code, out, err, ms: Date.now() - started })));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  return { child, done };
}

const isWaiting = (p: Promise<unknown>, ms = 1_500) => Promise.race([p.then(() => false), new Promise((r) => setTimeout(() => r(true), ms))]);

describe.runIf(onWindows)('the Windows hook over a real pipe', () => {
  it('answers nothing when memory allows, so Claude Code carries on', async () => {
    const dir = tmpDir();
    const server = await makeServer(dir);
    const r = await runShim(dir, 'pre', { command: 'git status' }).done;
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
    expect(server.status().counts.asked).toBe(1);
  });

  it.runIf(fs.existsSync(GIT_BASH))('works the same when Git Bash runs the command', async () => {
    const dir = tmpDir();
    const server = await makeServer(dir);
    const r = await runShim(dir, 'pre', { command: 'git status', shell: GIT_BASH }).done;
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(server.status().counts.asked).toBe(1);
  });

  it('holds a second heavy command until the first one reports back', async () => {
    const dir = tmpDir();
    await makeServer(dir);
    expect((await runShim(dir, 'pre', { id: 'first' }).done).out).toBe('');
    const second = runShim(dir, 'pre', { id: 'second', command: 'cargo build' });
    expect(await isWaiting(second.done)).toBe(true);
    await runShim(dir, 'post', { id: 'first' }).done;
    expect(await second.done).toMatchObject({ code: 0, out: '' });
  });

  it('ends a long wait with the refusal Claude Code reads', async () => {
    const dir = tmpDir();
    // The first grant is never measured on Windows, so it would be let go after
    // the longest wait, which here is shorter than the refusal takes to arrive.
    await makeServer(dir, { maxWaitMs: 300 }, 60_000);
    await runShim(dir, 'pre', { id: 'first' }).done;
    const r = await runShim(dir, 'pre', { id: 'second', command: 'cargo build' }).done;
    const said = JSON.parse(r.out);
    expect(said.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(said.hookSpecificOutput.permissionDecisionReason).toMatch(/heavier work/);
  });

  it('forgets a waiting command once Claude Code ends the .cmd, though Windows leaves the hook running', async () => {
    const dir = tmpDir();
    const server = await makeServer(dir);
    await runShim(dir, 'pre', { id: 'first' }).done;
    const second = runShim(dir, 'pre', { id: 'second', command: 'cargo build' });
    expect(await isWaiting(second.done)).toBe(true);
    expect(server.status().waiting).toHaveLength(1);
    second.child.kill();
    const until = Date.now() + 5_000;
    while (server.status().waiting.length && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    expect(server.status().waiting).toHaveLength(0);
  });

  it('runs the command at once when no coordinator is serving', async () => {
    const dir = tmpDir();
    const r = await runShim(dir, 'pre').done;
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(r.ms).toBeLessThan(5_000);
  });

  it('lets a waiting command run when the switch goes off mid-wait, and the marker goes with it', async () => {
    const dir = tmpDir();
    const server = await makeServer(dir);
    await runShim(dir, 'pre', { id: 'first' }).done;
    const second = runShim(dir, 'pre', { id: 'second', command: 'cargo build' });
    expect(await isWaiting(second.done)).toBe(true);
    await server.stop();
    expect(await second.done).toMatchObject({ code: 0, out: '' });
    expect(fs.readdirSync(path.join(dir, 'channels')).filter((f) => f.endsWith('.pipe'))).toEqual([]);
  });

  it('a supervisor turned on serves the channel and leaves no socket file', async () => {
    const sup = makeSupervisor(false);
    await sup.setMemoryGate(true);
    expect(sup.memoryGateStatus()!.role).toBe('owner');
    expect(fs.existsSync(sup.config.memoryGateSocket as string)).toBe(false);
    await sup.setMemoryGate(false);
    expect(sup.memoryGateStatus()).toBe(null);
  });
});
