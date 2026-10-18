// Rates editor (DESIGN.md screen 6): Betaflight rate types, per-axis sliders, the stick -> deg/s curve as in the
// Configurator, import / export of CLI lines. Stored per drone in settings.drones[id].rates.
import { useState } from 'preact/hooks';
import { applyRate, type RateProfile, type RateType } from '../../sim/rates';
import { defaultRates, ratesFromCli, ratesToCli } from '../../sim/cli';
import { Chips, Seg, Slider } from './bits';

type Axis = 'roll' | 'pitch' | 'yaw';
const AXES: { id: Axis; label: string }[] = [{ id: 'roll', label: 'Roll' }, { id: 'pitch', label: 'Pitch' }, { id: 'yaw', label: 'Yaw' }];
const TYPES: { id: RateType; label: string }[] = [
  { id: 'actual', label: 'Actual' }, { id: 'betaflight', label: 'Betaflight' }, { id: 'quick', label: 'Quick' }, { id: 'kiss', label: 'KISS' }, { id: 'raceflight', label: 'RaceFlight' },
];
/** slider labels / ranges per rates type, as the Configurator shows them */
const FIELDS: Record<RateType, [string, number, number, number][]> = {
  actual: [['Center sens. °/с', 10, 400, 5], ['Max rate °/с', 100, 1998, 10], ['Expo', 0, 1, 0.01]],
  betaflight: [['RC Rate', 0.01, 2.55, 0.01], ['Super Rate', 0, 0.99, 0.01], ['RC Expo', 0, 1, 0.01]],
  quick: [['RC Rate', 0.01, 2.55, 0.01], ['Max rate °/с', 100, 1998, 10], ['Expo', 0, 1, 0.01]],
  kiss: [['RC Rate', 0.01, 2.55, 0.01], ['Rate', 0, 0.99, 0.01], ['RC Curve', 0, 1, 0.01]],
  raceflight: [['Rate °/с', 10, 1998, 10], ['Acro+', 0, 2.55, 0.01], ['Expo', 0, 1, 0.01]],
};
const AXIS_COLOR: Record<Axis, string> = { roll: '#c8ff2e', pitch: '#3dd9ff', yaw: '#ffb020' };
const fmt = (step: number) => (v: number) => (step >= 1 ? String(Math.round(v)) : v.toFixed(2));

export function maxRate(p: RateProfile, a: Axis) { return Math.round(applyRate(p, a, 1)); }

function Curve({ p, axis }: { p: RateProfile; axis: Axis }) {
  const W = 400, H = 230, P = 30;
  const maxY = Math.max(600, Math.ceil(Math.max(...AXES.map((a) => maxRate(p, a.id))) / 300) * 300);
  const path = (a: Axis) => {
    let d = '';
    for (let i = 0; i <= 100; i++) {
      const x = i / 100, y = applyRate(p, a, x);
      d += `${i ? 'L' : 'M'}${(P + x * (W - 2 * P)).toFixed(1)},${(H - P - (y / maxY) * (H - 2 * P)).toFixed(1)}`;
    }
    return d;
  };
  const grid = [0, 1, 2, 3, 4].map((k) => {
    const y = H - P - (k * (H - 2 * P)) / 4;
    return <g><line x1={P} x2={W - P} y1={y} y2={y} stroke="rgba(255,255,255,.06)" />
      <text x={P - 6} y={y + 4} fill="#56606c" font-size="10" text-anchor="end" font-family="JetBrains Mono">{Math.round((k * maxY) / 4)}</text></g>;
  });
  return (
    <svg class="curve" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Кривая rates">
      {grid}
      {AXES.filter((a) => a.id !== axis).map((a) => <path d={path(a.id)} fill="none" stroke={AXIS_COLOR[a.id]} stroke-opacity=".28" stroke-width="2" />)}
      <path d={path(axis)} fill="none" stroke={AXIS_COLOR[axis]} stroke-width="3" stroke-linecap="round" />
      <text x={W - P} y={H - 8} fill="#56606c" font-size="10" text-anchor="end" font-family="JetBrains Mono">стик 100%</text>
      <text x={W - P} y={P - 10} fill={AXIS_COLOR[axis]} font-size="12" text-anchor="end" font-family="JetBrains Mono">{maxRate(p, axis)} °/с</text>
    </svg>
  );
}

export function RatesEditor({ value, base, onChange }: { value: RateProfile; base: RateProfile; onChange: (r: RateProfile | null) => void }) {
  const [axis, setAxis] = useState<Axis>('roll');
  const [cli, setCli] = useState<'' | 'import' | 'export'>('');
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const p = value;
  const set = (f: number, v: number) => {
    const n: RateProfile = { type: p.type, roll: [...p.roll], pitch: [...p.pitch], yaw: [...p.yaw] };
    n[axis][f] = v;
    if (axis !== 'yaw' && linked(p)) n[axis === 'roll' ? 'pitch' : 'roll'][f] = v; // roll and pitch move together until split
    onChange(n);
  };
  const linked = (r: RateProfile) => r.roll.every((x, i) => x === r.pitch[i]);
  const changeType = (t: RateType) => onChange(t === base.type ? base : defaultRates(t));
  const doImport = () => {
    const r = ratesFromCli(text, p);
    if (!r) { setMsg({ ok: false, t: 'Не нашёл строк rates (set roll_rc_rate = …)' }); return; }
    onChange(r); setMsg({ ok: true, t: `Применено: ${r.type.toUpperCase()}` }); setCli('');
  };
  return (
    <div>
      <div class="row2"><Chips value={axis} options={AXES} onChange={setAxis} /><span class="mono mute" style={{ fontSize: '12px' }}>
        {AXES.map((a) => `${a.label[0]} ${maxRate(p, a.id)}`).join(' · ')} °/с</span></div>
      <Curve p={p} axis={axis} />
      <div style={{ marginTop: '6px' }}><Seg value={p.type} options={TYPES} onChange={changeType} /></div>
      {FIELDS[p.type].map(([label, min, max, step], f) =>
        <Slider label={label} min={min} max={max} step={step} value={p[axis][f]} fmt={fmt(step)} onInput={(v) => set(f, v)} />)}
      <div class="btnrow">
        <button class="mbtn ghost small" onClick={() => { setCli(cli === 'import' ? '' : 'import'); setText(''); setMsg(null); }}>Импорт из CLI</button>
        <button class="mbtn ghost small" onClick={() => { setCli(cli === 'export' ? '' : 'export'); setText(ratesToCli(p)); setMsg(null); }}>Экспорт в CLI</button>
        <button class="mbtn ghost small" onClick={() => { onChange(null); setMsg({ ok: true, t: 'Rates пресета дрона' }); }}>Сбросить</button>
      </div>
      {cli === 'import' && <div>
        <textarea placeholder={'Вставь вывод Betaflight `diff` / `dump`:\nset rates_type = ACTUAL\nset roll_rc_rate = 7\n…'} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
        <div class="btnrow"><button class="mbtn primary small" onClick={doImport}>Применить</button></div>
      </div>}
      {cli === 'export' && <div>
        <textarea readOnly value={text} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />
        <div class="btnrow"><button class="mbtn ghost small" onClick={() => navigator.clipboard?.writeText(text).then(() => setMsg({ ok: true, t: 'Скопировано — вставь в CLI Betaflight и `save`' }), () => setMsg({ ok: false, t: 'Буфер обмена недоступен — выдели текст вручную' }))}>Копировать</button></div>
      </div>}
      {msg && <p class={msg.ok ? 'ok' : 'err'}>{msg.t}</p>}
    </div>
  );
}
