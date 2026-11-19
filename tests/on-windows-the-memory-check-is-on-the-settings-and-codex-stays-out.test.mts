// ON WINDOWS THE MEMORY CHECK IS ON THE SETTINGS, AND CODEX STAYS OUT.
//
// #66 turned the check off on Windows and took its switch off the Running page:
// the coordinator listened on a unix socket, which failed with `listen EACCES`,
// and a Claude worker's hook asked over it with curl. The coordinator now
// serves the app's local channel and a Claude worker asks through
// scripts/memory-gate-hook.cmd
// (tests/on-windows-a-claude-workers-commands-ask-the-memory-check-over-the-apps-own-channel),
// so the switch is back. Codex still gets no hook on Windows
// (tests/on-windows-no-codex-hook-is-written-into-anyones-codex-home), so its
// app-server gets no gate variables there either. A desktop from before this
// still sends the phone no memory rows, and the phone still shows none.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../main/supervisor.mts';
import { memoryGateSettings } from '../main/settings.mts';
import { gateRaisesAgents } from '../main/memory-gate.mts';
import { phoneSettingsOf } from '../shared/phone-settings.mts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const made: Supervisor[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', realPlatform);
  for (const s of made.splice(0)) await s.stopMemoryGate?.();
});

const item = { id: 'w-1', product: 'demo', priority: 7 };
const settingsSupervisor = { memoryGateStatus: () => null, leftoverStatus: () => null, startHoldStatus: () => null };

function makeSupervisor(memoryGate = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-win-'));
  const store = { listItems: () => [], listProducts: () => [], isDue: () => true, readItem: () => null };
  const sup = new Supervisor({ storeRoot: tmp, home: tmp, codexHome: path.join(tmp, '.codex'), memoryGate, memoryGateSocket: path.join(tmp, 'g.sock'), memoryGateLockPort: 0 }, store, root, tmp, tmp);
  made.push(sup);
  return sup;
}

describe('the Running page', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    it(`shows the memory switch, on, on ${platform}`, () => {
      Object.defineProperty(process, 'platform', { value: platform });
      expect(memoryGateSettings({ config: { memoryGate: true }, supervisor: settingsSupervisor })?.on).toBe(true);
    });
  }

  it('shows it off when it is switched off', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(memoryGateSettings({ config: { memoryGate: false }, supervisor: settingsSupervisor })?.on).toBe(false);
  });
});

describe('how many agents Automatic runs', () => {
  it('is raised by the check on a Mac and Linux, where every worker\'s commands are held', () => {
    expect(gateRaisesAgents(true, 'darwin')).toBe(true);
    expect(gateRaisesAgents(true, 'linux')).toBe(true);
  });

  it('is not raised on Windows, where a Codex worker\'s commands are not', () => {
    expect(gateRaisesAgents(true, 'win32')).toBe(false);
  });

  it('is not raised anywhere with the check off', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) expect(gateRaisesAgents(false, platform)).toBe(false);
  });
});

describe('a Codex app-server', () => {
  it('gets no gate variables on Windows, where no Codex hook reads them', () => {
    expect(makeSupervisor().codexMemoryGateEnv('win32')).toEqual({});
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`still gets the socket on ${platform}`, () => {
      expect(makeSupervisor().codexMemoryGateEnv(platform)).toHaveProperty('AGENTBOX_GATE_SOCK');
    });
  }

  it('gets nothing anywhere with the switch off', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(makeSupervisor(false).codexMemoryGateEnv(platform)).toEqual({});
    }
  });
});

describe('a Claude worker on a Mac or Linux', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`still carries the .sh hook and the socket (${platform})`, () => {
      const sup = makeSupervisor();
      expect(JSON.stringify(sup.memoryGateHooks(platform))).toContain('memory-gate-hook.sh');
      expect(sup.memoryGateEnv(item, platform)).toHaveProperty('AGENTBOX_GATE_SOCK');
    });
  }
});

describe('the phone', () => {
  it('shows no memory rows for a desktop that sends none, and the rows for one that does', () => {
    const older = phoneSettingsOf({ ok: true, workspace: { memoryGate: null } }, { version: null });
    expect(older?.workspace.memoryGate).toBeNull();
    const now = phoneSettingsOf({ ok: true, workspace: { memoryGate: { on: true, slots: null, slotsAuto: 2, slotsMax: 12, now: null } } }, { version: null });
    expect(now?.workspace.memoryGate?.on).toBe(true);
  });
});
