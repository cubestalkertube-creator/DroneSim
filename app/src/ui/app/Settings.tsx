// Settings (DESIGN.md screen 6): side menu of sections. Used from the main menu and from the pause screen
// (then changes apply to the running flight through ui.hooks).
import { useState } from 'preact/hooks';
import { settings, updateSettings } from '../../core/settings';
import { pickQuality, saveQuality, type QualityId } from '../../render/quality';
import { loadSoundPrefs, saveSoundPrefs } from '../../audio/engine';
import type { RateProfile } from '../../sim/rates';
import { droneTitle } from '../catalog';
import { ControlsSection } from './Controls';
import { RatesEditor } from './RatesEditor';
import { Chips, Opt, Seg, Slider } from './bits';
import { ui } from './store';
import { MISS_PENALTY_S } from '../../game/race';

type Section = 'controls' | 'rates' | 'graphics' | 'sound' | 'gameplay';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'controls', label: 'Управление' }, { id: 'rates', label: 'Rates и expo' }, { id: 'graphics', label: 'Графика' },
  { id: 'sound', label: 'Звук' }, { id: 'gameplay', label: 'Геймплей' },
];

export function ratesFor(droneId: string): { value: RateProfile; base: RateProfile } | null {
  const p = ui.presets.value.find((d) => d.id === droneId);
  if (!p?.fc.rates) return null;
  return { value: settings.value.drones[droneId]?.rates ?? p.fc.rates, base: p.fc.rates };
}

export function setRates(droneId: string, r: RateProfile | null) {
  updateSettings((s) => {
    const d = (s.drones[droneId] ??= {});
    if (r) d.rates = r; else delete d.rates;
  });
  ui.hooks?.applyRates(droneId, r);
}

function RatesSection({ inFlight }: { inFlight: boolean }) {
  const fpv = ui.presets.value.filter((p) => p.fc.type === 'betaflight' && p.fc.rates);
  const cur = settings.value.drone;
  const [id, setId] = useState(fpv.some((p) => p.id === cur) ? cur : fpv[0]?.id ?? '');
  const r = ratesFor(id);
  return (
    <div class="cards">
      <div class="mcard glass">
        <div class="h3">Rates · {r?.value.type.toUpperCase()}</div>
        <p>Кривая «стик → угловая скорость» Betaflight для FPV-дронов (Acro). Значения как в Configurator; можно вставить свои из CLI.</p>
        {!inFlight && <div style={{ margin: '12px 0' }}><Chips value={id} options={fpv.map((p) => ({ id: p.id, label: droneTitle(p) }))} onChange={setId} /></div>}
        {inFlight && !r && <p>У этого дрона нет rates Betaflight (GPS / автопилот) — стики задают скорость или наклон.</p>}
        {r && <RatesEditor value={r.value} base={r.base} onChange={(v) => setRates(id, v)} />}
      </div>
    </div>
  );
}

function GraphicsSection({ inFlight }: { inFlight: boolean }) {
  const [q, setQ] = useState<QualityId>(pickQuality().id);
  const [changed, setChanged] = useState(false);
  return (
    <div class="cards"><div class="mcard glass">
      <div class="h3">Графика</div>
      <Opt title="Качество" hint="Low — телефоны: 1k-текстуры, тень 1024, рендер ×0.75, физика 500 Гц. High — мягкие тени, сглаживание, 1000 Гц.">
        <Seg value={q} options={[{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }]}
          onChange={(v) => { setQ(v); saveQuality(v); setChanged(true); }} />
      </Opt>
      {changed && inFlight && <p class="ok">Применится при следующем запуске полёта.</p>}
    </div></div>
  );
}

function SoundSection() {
  const [s, setS] = useState(loadSoundPrefs());
  const set = (volume: number, muted: boolean) => { setS({ volume, muted }); saveSoundPrefs(volume, muted); ui.hooks?.setSound(volume, muted); };
  return (
    <div class="cards"><div class="mcard glass">
      <div class="h3">Звук</div>
      <Opt title="Звук" hint="Синтез моторов по оборотам, ветер, удары, бипы. В полёте — U."><Seg value={s.muted ? 'off' : 'on'} options={[{ id: 'on', label: 'Вкл' }, { id: 'off', label: 'Выкл' }]} onChange={(v) => set(s.volume, v === 'off')} /></Opt>
      <Slider label="Громкость" min={0} max={1} step={0.05} value={s.volume} fmt={(v) => `${Math.round(v * 100)}%`} disabled={s.muted} onInput={(v) => set(v, s.muted)} />
    </div></div>
  );
}

function GameplaySection() {
  const g = settings.value.gameplay;
  return (
    <div class="cards"><div class="mcard glass">
      <div class="h3">Геймплей</div>
      <Opt title="Подсказки в полёте" hint="«Пробел — арм», «газ вверх — взлёт» и т. п. по центру экрана.">
        <Seg value={g.hints ? 'on' : 'off'} options={[{ id: 'on', label: 'Вкл' }, { id: 'off', label: 'Выкл' }]} onChange={(v) => updateSettings((s) => { s.gameplay.hints = v === 'on'; })} />
      </Opt>
      <Opt title="Пропуск ворот в гонке" hint={`Пролёт мимо ворот к следующим: +${MISS_PENALTY_S} с за каждые ворота или круг не засчитывается.`}>
        <Seg value={g.gateMiss} options={[{ id: 'penalty', label: `+${MISS_PENALTY_S} с` }, { id: 'dnf', label: 'Незачёт' }]} onChange={(v) => updateSettings((s) => { s.gameplay.gateMiss = v; })} />
      </Opt>
    </div></div>
  );
}

export function SettingsBody({ inFlight = false }: { inFlight?: boolean }) {
  const [sec, setSec] = useState<Section>('controls');
  return (
    <div class="scols">
      <div class="side glass">{SECTIONS.map((s) => <button class={sec === s.id ? 'on' : ''} aria-current={sec === s.id} onClick={() => setSec(s.id)}>{s.label}</button>)}</div>
      <div>
        {sec === 'controls' && <ControlsSection />}
        {sec === 'rates' && <RatesSection inFlight={inFlight} />}
        {sec === 'graphics' && <GraphicsSection inFlight={inFlight} />}
        {sec === 'sound' && <SoundSection />}
        {sec === 'gameplay' && <GameplaySection />}
      </div>
    </div>
  );
}
