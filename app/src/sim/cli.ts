// Betaflight CLI <-> RateProfile: paste `diff`/`dump` lines (`set roll_rc_rate = 7`) and get the same stick feel.
// Stored CLI integers per rates_type (Betaflight 4.x rc.c / configurator):
//   BETAFLIGHT: rc_rate x100, srate x100, expo x100      ACTUAL: center/10, max/10, expo x100
//   QUICK:      rc_rate x100, max/10,     expo x100      KISS:   rc_rate x100, rate x100, curve x100
//   RACEFLIGHT: rate/10,      acro+ x100, expo x100
import type { RateProfile, RateTriple, RateType } from './rates';

const SCALE: Record<RateType, RateTriple> = {
  betaflight: [100, 100, 100], actual: [0.1, 0.1, 100], quick: [100, 0.1, 100], kiss: [100, 100, 100], raceflight: [0.1, 100, 100],
};
const AXES = ['roll', 'pitch', 'yaw'] as const;
const FIELD = ['rc_rate', 'srate', 'expo'] as const;

/** Parse `set name = value` lines into a map (comments, `#`, other commands ignored). */
export function parseCliSettings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*set\s+([a-z0-9_]+)\s*=\s*(\S+)/i.exec(line);
    if (m) out.set(m[1].toLowerCase(), m[2]);
  }
  return out;
}

/**
 * Apply Betaflight CLI rate settings on top of `base`. Unknown/absent fields keep the base value
 * (converted if rates_type changes, the triple is reset to Betaflight's defaults for that type).
 * Returns null when the text has no rate settings at all.
 */
export function ratesFromCli(text: string, base: RateProfile): RateProfile | null {
  const s = parseCliSettings(text);
  const typeStr = s.get('rates_type')?.toLowerCase();
  const type = (typeStr && typeStr in SCALE ? typeStr : base.type) as RateType;
  const p: RateProfile = type === base.type
    ? { type, roll: [...base.roll], pitch: [...base.pitch], yaw: [...base.yaw] }
    : defaultRates(type);
  let found = !!typeStr;
  const num = (k: string) => { const v = s.get(k); if (v === undefined) return undefined; const x = Number(v); return Number.isFinite(x) ? x : undefined; };
  const put = (axis: (typeof AXES)[number], f: number, stored: number | undefined) => {
    if (stored === undefined) return;
    p[axis][f] = stored / SCALE[type][f]; found = true;
  };
  for (const axis of AXES) for (let f = 0; f < 3; f++) put(axis, f, num(`${axis}_${FIELD[f]}`));
  // Betaflight <= 4.0 names: rc_rate / rc_expo shared by roll+pitch, *_yaw for yaw, roll_srate etc. as now
  put('roll', 0, num('rc_rate')); put('pitch', 0, num('rc_rate')); put('yaw', 0, num('rc_rate_yaw'));
  put('roll', 2, num('rc_expo')); put('pitch', 2, num('rc_expo')); put('yaw', 2, num('rc_expo_yaw'));
  return found ? p : null;
}

/** Export as Betaflight CLI lines (paste into the CLI tab, then `save`). */
export function ratesToCli(p: RateProfile): string {
  const lines = [`set rates_type = ${p.type.toUpperCase()}`];
  for (const axis of AXES) for (let f = 0; f < 3; f++) {
    lines.push(`set ${axis}_${FIELD[f]} = ${Math.round(p[axis][f] * SCALE[p.type][f])}`);
  }
  return lines.join('\n');
}

/** Betaflight 4.x defaults per rates type (as shown in the configurator). */
export function defaultRates(type: RateType): RateProfile {
  const t = (rp: RateTriple, y: RateTriple): RateProfile => ({ type, roll: [...rp], pitch: [...rp], yaw: y });
  switch (type) {
    case 'actual': return t([70, 670, 0], [70, 670, 0]);
    case 'betaflight': return t([1, 0.7, 0], [1, 0.7, 0]);
    case 'quick': return t([1, 670, 0], [1, 670, 0]);
    case 'kiss': return t([1, 0.7, 0], [1, 0.7, 0]);
    case 'raceflight': return t([370, 0.8, 0.5], [370, 0.8, 0.5]);
  }
}
