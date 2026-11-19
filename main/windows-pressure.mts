// HOW SHORT OF MEMORY THIS WINDOWS MACHINE IS, IN THE MAC'S TERMS.
//
// Windows has no kernel pressure level to read without starting a program
// (perf counters need PowerShell or typeperf). What it does give for free is
// available physical memory: libuv's free memory on Windows is
// GlobalMemoryStatusEx's ullAvailPhys, which counts the standby cache the way
// the Mac's kern.memorystatus_level counts what it can reclaim. So the share of
// it is handed on as `freePct` and judged by the same lines as on a Mac, and
// the level and swap rate stay null: unknown, never read as normal by mistake.

import os from 'node:os';
import type { PressureReading } from './memory-gate.mts';

/** Available memory as a whole-number share of the total, or null when either is unreadable. Pure. */
export function freePctFrom(freeBytes: unknown, totalBytes: unknown): number | null {
  const free = Number(freeBytes);
  const total = Number(totalBytes);
  if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0 || free < 0) return null;
  return Math.min(100, Math.floor((free / total) * 100));
}

export interface MemoryNumbers { freemem: () => number; totalmem: () => number }

/** This machine's reading now. No program is started; never throws. */
export function readWindowsPressure(mem: MemoryNumbers = os): PressureReading {
  let freePct: number | null = null;
  try { freePct = freePctFrom(mem.freemem(), mem.totalmem()); } catch { freePct = null; }
  return { level: null, freePct, swapInMbps: null, swapMb: null };
}
