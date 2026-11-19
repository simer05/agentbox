// Runs the app's own Windows install command for Claude Code and Codex on a
// fresh GitHub Windows machine, then asks the app's own finders for them.
// Test-only: this file and its workflow live on a throwaway branch.
import { spawn, spawnSync } from 'node:child_process';
import { installCommand } from '../main/engine-setup.mts';
import { terminalEnv } from '../main/task-terminals.mts';
import { findClaudeBin } from '../main/claude-bin.mts';
import { findCodexBin } from '../main/codex-bin.mts';

const finders = { claude: findClaudeBin, codex: findCodexBin } as const;
const TEN_MINUTES = 10 * 60_000;

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => { console.log('installer timed out'); child.kill(); }, TEN_MINUTES);
    child.on('error', (e) => { clearTimeout(timer); console.log('spawn error:', e.message); resolve(null); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

let failed = false;
for (const engine of ['claude', 'codex'] as const) {
  console.log(`\n===== ${engine} =====`);
  const before = finders[engine]();
  console.log('before install, found:', before.found, before.path);
  const env = terminalEnv(process.env);
  const { file, args, env: installEnv } = installCommand(engine, 'win32', env);
  console.log('install command:', file, args.join(' '));
  console.log('PSModulePath here:', env.PSModulePath ?? '(none)', '| handed to the installer:', installEnv ? (Object.keys(installEnv).some((k) => k.toLowerCase() === 'psmodulepath') ? 'kept' : 'removed') : 'same env');
  const code = await run(file, args, installEnv ?? env);
  console.log('installer exit code:', code);
  const after = finders[engine]();
  console.log('after install, found:', after.found, after.path, 'from:', after.from);
  if (code !== 0 || !after.found || !after.path) { failed = true; console.log(`FAIL: ${engine}`); continue; }
  const v = spawnSync(after.path, ['--version'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  console.log('version:', (v.stdout || v.stderr || String(v.error)).trim());
  if (v.status !== 0) { failed = true; console.log(`FAIL: ${engine} --version`); } else console.log(`PASS: ${engine}`);
}
process.exit(failed ? 1 : 0);
