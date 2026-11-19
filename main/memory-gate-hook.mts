// THE MEMORY CHECK'S HOOK ON WINDOWS.
//
// scripts/memory-gate-hook.sh is the hook on macOS and Linux. cmd.exe cannot
// run it, and the coordinator it asks cannot listen on a
// socket file there, so on Windows scripts/memory-gate-hook.cmd starts this
// file on the app's own binary as a node and it asks the coordinator over the
// local channel (main/local-channel.mts) instead. What it sends and what it
// prints are in the script's format, and so is the promise that it fails
// open, fast: no coordinator means run now, one that stops answering is tried
// five times a second apart, and every wait ends inside the hook's own limit.
//
//   memory-gate-hook.mts <pre|post>    the hook payload on stdin

import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectLocal, markerFile } from './local-channel.mts';

/** Must match CHANNEL_KIND in main/memory-gate-server.mts, which this file does not import so it starts fast. */
export const GATE_KIND = 'memory-gate';

type Env = Record<string, string | undefined>;

// Only what is safe to paste into JSON gets through from the environment.
const clean = (s: unknown) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '');

/** The request body, exactly as the shell script builds it. `input` is pasted in as the script pastes it. */
export function hookBody(mode: string, input: string, env: Env, ppid: number): string {
  const score = /^[0-9]+$/.test(env.AGENTBOX_GATE_SCORE ?? '0') ? (env.AGENTBOX_GATE_SCORE || '0') : '0';
  const hook = input.replace(/\n+$/, '') || 'null';
  return `{"v":1,"event":"${mode}","item":"${clean(env.AGENTBOX_GATE_ITEM)}","product":"${clean(env.AGENTBOX_GATE_PRODUCT)}","score":${score},"ppid":${ppid},"hook":${hook}}`;
}

/** One POST over an open connection; resolves with the answer, rejects as `curl -f` fails. */
export function ask(sock: net.Socket, route: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, answer = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(answer);
    };
    const timer = setTimeout(() => { req.destroy(); finish(new Error(`no answer within ${timeoutMs} ms`)); }, timeoutMs);
    const req = http.request({
      method: 'POST', host: 'agentbox', path: route, createConnection: () => sock,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let answer = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { answer += d; });
      res.on('end', () => finish(res.statusCode === 200 ? null : new Error(`answered ${res.statusCode}`), answer));
      res.on('error', (err) => finish(err));
    });
    req.on('error', (err) => finish(err));
    req.end(body);
  });
}

export interface HookRun {
  mode: string;
  input: string;
  env: Env;
  ppid: number;
  connect?: (env: Env) => Promise<net.Socket>;
  listed?: (env: Env) => boolean;
  print?: (answer: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const channelOf = (env: Env) => ({ kind: GATE_KIND, stamp: env.AGENTBOX_GATE_STAMP ?? '', dir: env.AGENTBOX_GATE_CHANNEL! });

export async function runHook({
  mode, input, env, ppid,
  connect = (e) => connectLocal({ ...channelOf(e), timeoutMs: 2_000 }),
  listed = (e) => fs.existsSync(markerFile(e.AGENTBOX_GATE_CHANNEL!, GATE_KIND, e.AGENTBOX_GATE_STAMP ?? '')),
  print = (answer) => { process.stdout.write(answer); },
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}: HookRun): Promise<void> {
  if (!env.AGENTBOX_GATE_CHANNEL || !listed(env)) return;
  const body = hookBody(mode, input, env, ppid);
  if (mode !== 'pre') {
    try { await ask(await connect(env), `/${mode}`, body, 5_000); } catch { /* an after report that is lost costs a slot, never the command */ }
    return;
  }
  const maxMs = (Number(env.AGENTBOX_GATE_MAX_S) || 1700) * 1000;
  const retryMs = (Number(env.AGENTBOX_GATE_RETRY_S) || 1) * 1000;
  for (let tries = 1; ; tries++) {
    try {
      print(await ask(await connect(env), '/pre', body, maxMs));
      return;
    } catch { /* tried again below, as the script does */ }
    if (tries >= 5 || !listed(env)) return;
    await sleep(retryMs);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
if (entry === fileURLToPath(import.meta.url).toLowerCase()) {
  // Ending the .cmd that started this leaves it running on Windows. Once its
  // parent is gone nothing reads the answer, so it goes too, and the app
  // forgets the request instead of granting a slot to a command that is gone.
  const parent = process.ppid;
  setInterval(() => {
    try { process.kill(parent, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') process.exit(0); }
  }, 1_000).unref();
  readStdin()
    .then((input) => runHook({ mode: process.argv[2] ?? '', input, env: process.env, ppid: parent }))
    .catch(() => {})
    .finally(() => { process.exitCode = 0; });
}
