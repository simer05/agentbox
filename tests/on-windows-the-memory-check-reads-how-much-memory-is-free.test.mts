// ON WINDOWS THE MEMORY CHECK READS HOW MUCH MEMORY IS FREE.
//
// Every reading of memory pressure came from `sysctl`, which Windows does not
// have, so on Windows each one was null: no new agent was ever held at the
// door, no heavy command ever waited, and the memory log wrote nothing about
// pressure. Measured on Windows 11 with Node 24.11: readMacPressure returned
// { level: null, freePct: null } every time.
//
// Windows now reads its available-memory share with os.freemem() and
// os.totalmem(), which is GlobalMemoryStatusEx's ullAvailPhys and starts no
// program, and that share is judged by the Mac's own lines. On Linux and the
// Mac the reading is what it was.

import { describe, it, expect } from 'vitest';
import { pressureFrom } from '../main/memory-gate.mts';
import { freePctFrom, readWindowsPressure } from '../main/windows-pressure.mts';
import { readMacPressure } from '../main/mac-pressure.mts';
import { readMacPressureNow, startDecision } from '../main/start-hold.mts';

const mem = (free: number, total = 100) => ({ freemem: () => free, totalmem: () => total });

describe('reading memory on Windows', () => {
  it('is the available share of the total, in whole percent', () => {
    expect(freePctFrom(8 * 1024 ** 3, 16 * 1024 ** 3)).toBe(50);
    expect(freePctFrom(119, 1000)).toBe(11);
    expect(freePctFrom(0, 1000)).toBe(0);
  });

  it('is unknown, not normal, when it cannot be read', () => {
    expect(freePctFrom(1, 0)).toBe(null);
    expect(freePctFrom(Number.NaN, 100)).toBe(null);
    expect(freePctFrom(-1, 100)).toBe(null);
    const broken = { freemem: () => { throw new Error('no'); }, totalmem: () => 100 };
    expect(readWindowsPressure(broken)).toEqual({ level: null, freePct: null, swapInMbps: null, swapMb: null });
  });

  it('is judged by the same lines as a Mac: under 12% tight, under 5% critical', () => {
    const word = (free: number) => pressureFrom(readWindowsPressure(mem(free)));
    expect(word(40)).toBe('normal');
    expect(word(12)).toBe('normal');
    expect(word(11)).toBe('tight');
    expect(word(5)).toBe('tight');
    expect(word(4)).toBe('critical');
  });

  it('is what every reader of the pressure gets on Windows, with no level or swap rate', async () => {
    const r = await readMacPressure('win32');
    expect(r.level).toBe(null);
    expect(r.swapInMbps).toBe(null);
    expect(typeof r.freePct).toBe('number');
    const now = readMacPressureNow('win32');
    expect(typeof now.freePct).toBe('number');
    expect(Math.abs(Date.now() - now.at)).toBeLessThan(5_000);
  });

  it('holds a new agent while short and lets one start while not', () => {
    const at = Date.now();
    const short = { ...readWindowsPressure(mem(4)), at };
    const roomy = { ...readWindowsPressure(mem(40)), at };
    expect(startDecision({ on: true, reading: short, now: at, running: 2 })).toEqual({ start: false, why: 'critical' });
    expect(startDecision({ on: true, reading: roomy, now: at, running: 2 })).toEqual({ start: true, why: 'normal' });
  });

  // Off a Mac there is no sysctl, so a Mac or Linux reading here is all nulls,
  // never the Windows share.
  it.runIf(process.platform !== 'darwin')('is not what Linux or a Mac reads', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const r = await readMacPressure(platform);
      expect(r.freePct).toBe(null);
      expect(r.level).toBe(null);
      expect(readMacPressureNow(platform)).toMatchObject({ level: null, freePct: null });
    }
  });
});
