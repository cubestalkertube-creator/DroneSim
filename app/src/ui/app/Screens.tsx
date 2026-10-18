// Menu screens per docs/design/ui_mockup.html: main menu, play mode, map select (+ conditions), drone select,
// hangar (per-drone setup), academy path, credits.
import { useEffect, useState } from 'preact/hooks';
import { settings, updateSettings } from '../../core/settings';
import { progress, bestLap, hasGhost } from '../../core/progress';
import type { DronePreset } from '../../sim/presets';
import { DRONE_TABS, DRONE_TEXT, LESSONS, MAPS, MAP_TAGS, droneFacts, droneTab, droneTitle, modeName, type DroneTab, type MapTag } from '../catalog';
import { activePad, padName } from '../../input/input';
import { BackBtn, Chips, Opt, Slider, Stars, Stat } from './bits';
import { RatesEditor } from './RatesEditor';
import { ratesFor, setRates } from './Settings';
import { ASSETS, go, ui } from './store';
import { MISS_PENALTY_S } from '../../game/race';
import { version } from '../../../package.json';
import { lessonUnlocked } from '../../game/academy/lessons';

const DEV = import.meta.env.DEV;
const mapsAvailable = () => MAPS.filter((m) => m.shipped || DEV);
const preset = (id: string) => ui.presets.value.find((d) => d.id === id) ?? ui.presets.value[0];
const launch = () => ui.launch?.({ map: settings.value.map, drone: settings.value.drone, mode: ui.playMode.value });
/** the gate race: multirotors only (wings and the quadplane do not fit through 1.6 m gates) */
const RACE_MAP = 'training_field';
const raceable = (d: DronePreset) => !d.launch && !d.aero;
const free = () => { ui.playMode.value = 'free'; };
const fmtLap = (t: number) => (isFinite(t) ? `${Math.floor(t / 60).toString().padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}` : '—');

/** Connected transmitter / gamepad name, refreshed twice a second. */
function usePadName() {
  const [n, setN] = useState('');
  useEffect(() => {
    const t = setInterval(() => { const p = activePad(); setN(p ? padName(p.id) : ''); }, 500);
    return () => clearInterval(t);
  }, []);
  return n;
}

const DroneImg = ({ id, alt = '' }: { id: string; alt?: string }) => <img src={`${ASSETS}ui/drones/${id}.webp`} alt={alt} draggable={false} />;

export function MainMenu() {
  const s = settings.value, p = preset(s.drone), pad = usePadName();
  if (!p) return <div class="scr" />;
  const f = droneFacts(p);
  const done = LESSONS.filter((l) => (progress.value.lessons[l.id]?.stars ?? 0) > 0).length;
  return (
    <div class="scr">
      <div class="bgimg" style={{ backgroundImage: `url(${ASSETS}ui/maps/${s.map}.jpg)` }} /><div class="shade" />
      <div class="mainwrap">
        <div>
          <div class="mlogo"><div class="mark">◆</div>DRONESIM</div>
          <div class="eyebrow tagline">Симулятор пилотирования</div>
          <div class="h1">Летай.<br />Как в жизни.</div>
          <nav class="menu">
            <button autoFocus onClick={() => go('play')}>Играть <span>свободный полёт · гонка</span></button>
            <button onClick={() => go('academy')}>Академия <span>{done} / {LESSONS.length} уроков</span></button>
            <button onClick={() => { free(); go('hangar'); }}>Ангар <span>{ui.presets.value.length} дронов</span></button>
            <button onClick={() => go('settings')}>Настройки <span>{pad || (ui.touch ? 'тач-стики' : 'клавиатура')}</span></button>
            <button onClick={() => go('credits')}>Титры</button>
          </nav>
        </div>
        <div class="spacer" />
        <div class="dronecard glass">
          <div class="eyebrow" style={{ marginBottom: '12px' }}>Текущий дрон</div>
          <DroneImg id={p.id} />
          <div class="row2" style={{ margin: '14px 0 12px' }}><div class="h3">{droneTitle(p)}</div><span class="chip">{modeName(p.fc.default_mode)}</span></div>
          <div class="stats" style={{ display: 'grid', gap: '9px' }}>
            <Stat label="Тяга / вес" v={f.bars.agility} value={f.twr} />
            <Stat label="Макс. скорость" v={f.bars.speed} value={p.reference?.top_speed_kmh ?? '—'} />
            <Stat label="Время полёта" v={f.bars.endurance} value={f.time.replace(' мин', '')} />
          </div>
          <button class="mbtn primary" style={{ width: '100%', marginTop: '16px' }} onClick={() => { free(); launch(); }}>Взлёт · {MAPS.find((m) => m.id === s.map)?.name ?? s.map}</button>
        </div>
      </div>
      <div class="statusbar">
        <span><span class={`dot${pad ? '' : ' off'}`} />{pad ? `${pad} подключён` : ui.touch ? 'Тач-управление' : 'Клавиатура · подключи пульт или геймпад'}</span>
        <span class="mono ver">v{version} · физика 1000 Гц</span>
        {!ui.touch && <span><kbd>↑↓</kbd> выбор <kbd>Enter</kbd> ок <kbd>Esc</kbd> назад</span>}
      </div>
    </div>
  );
}

export function PlayScreen() {
  const modes = [
    { id: 'free', title: 'Свободный полёт', text: 'Любая карта и дрон, ветер, мгновенный рестарт. На «Полигоне» — ворота с таймером круга.', on: () => { free(); go('maps'); } },
    { id: 'race', title: 'Гонка', text: 'Time trial по 10 воротам «Полигона»: сплиты по воротам, призрак лучшего круга, штраф за пропуск ворот.', on: () => {
      ui.playMode.value = 'race';
      updateSettings((s) => { s.map = RACE_MAP; if (!raceable(preset(s.drone))) s.drone = 'fpv_5in_freestyle'; });
      go('drones');
    } },
    { id: 'academy', title: 'Академия', text: 'Путь пилота от стиков до трюков и крыла.', on: () => go('academy') },
    { id: 'freestyle', title: 'Фристайл', text: 'Очки за трюки и близость к препятствиям. Скоро.', soon: true },
    { id: 'missions', title: 'Миссии', text: 'Инспекция, поиск, доставка груза, картография. Скоро.', soon: true },
  ];
  return (
    <div class="scr"><div class="page">
      <BackBtn />
      <div class="head"><div><div class="eyebrow">Играть</div><div class="h2" style={{ marginTop: '6px' }}>Выбери режим</div></div></div>
      <div class="modes">{modes.map((m, i) => (
        <button class={`modecard${m.soon ? ' soon' : ''}`} disabled={m.soon} autoFocus={i === 0} onClick={m.on}>
          <span class="h3">{m.title}</span><span class="mute" style={{ fontSize: '13px', lineHeight: 1.5 }}>{m.text}</span>
        </button>))}
      </div>
    </div></div>
  );
}

export function MapsScreen() {
  const [tag, setTag] = useState<MapTag | 'all'>('all');
  const s = settings.value;
  const list = mapsAvailable().filter((m) => tag === 'all' || m.tags.includes(tag));
  const w = s.wind;
  const setWind = (mean_ms: number, dir_deg: number) => updateSettings((x) => { x.wind = { mean_ms, dir_deg }; });
  return (
    <div class="scr">
      <div class="page">
        <BackBtn />
        <div class="head"><div><div class="eyebrow">Свободный полёт · шаг 1 из 2</div><div class="h2" style={{ marginTop: '6px' }}>Выбери локацию</div></div>
          <Chips value={tag} options={MAP_TAGS} onChange={setTag} /></div>
        <div class="grid-maps">{list.map((m) => (
          <button class={`mapcard${m.id === s.map ? ' on' : ''}`} aria-pressed={m.id === s.map} autoFocus={m.id === s.map}
            onClick={() => updateSettings((x) => { x.map = m.id; })} onDblClick={() => go('drones')}>
            <span class="chip tag">{m.weather}{!m.shipped && ' · dev'}</span>
            <img src={`${ASSETS}ui/maps/${m.id}.jpg`} alt="" loading="lazy" />
            <div class="meta"><div><div class="h3">{m.name}</div><div class="mute" style={{ fontSize: '13px', marginTop: '4px' }}>{m.blurb}</div></div>
              <Stars n={m.difficulty} of={5} /></div>
          </button>))}
        </div>
      </div>
      <div class="footer-cta">
        <div class="cond">
          <label>Ветер<span class="seg">
            <button class={!w ? 'on' : ''} onClick={() => updateSettings((x) => { x.wind = null; })}>как на карте</button>
            <button class={w ? 'on' : ''} onClick={() => setWind(w?.mean_ms ?? 3, w?.dir_deg ?? 240)}>свой</button></span></label>
          {w && <label>Скорость, м/с <span class="mono" style={{ color: 'var(--text)' }}>{w.mean_ms.toFixed(1)}</span>
            <input type="range" min={0} max={15} step={0.5} value={w.mean_ms} onInput={(e) => setWind(+(e.target as HTMLInputElement).value, w.dir_deg)} /></label>}
          {w && <label>Откуда дует <span class="mono" style={{ color: 'var(--text)' }}>{w.dir_deg}° {compass(w.dir_deg)}</span>
            <input type="range" min={0} max={345} step={15} value={w.dir_deg} onInput={(e) => setWind(w.mean_ms, +(e.target as HTMLInputElement).value)} /></label>}
        </div>
        <div class="acts"><button class="mbtn primary" onClick={() => go('drones')}>Далее · дрон →</button></div>
      </div>
    </div>
  );
}
const compass = (d: number) => ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'][Math.round(d / 45) % 8];

function DroneSpec({ p }: { p: DronePreset }) {
  const f = droneFacts(p), t = DRONE_TEXT[p.id];
  return (
    <div class="spec glass">
      <div><div class="eyebrow">{t?.kind ?? p.class}</div><div class="h2" style={{ marginTop: '6px' }}>{droneTitle(p)}</div>
        <p class="desc" style={{ fontSize: '14px' }}>{t?.text}</p></div>
      <div class="kv">
        <div><small>Масса</small><b>{f.mass}</b></div><div><small>Тяга / вес</small><b>{f.twr}</b></div>
        <div><small>Макс. скорость</small><b>{f.speed}</b></div><div><small>Время полёта</small><b>{f.time}</b></div>
        {p.warhead && <div><small>Заряд</small><b style={{ color: 'var(--danger)' }}>✸ {p.warhead.mass} кг</b></div>}
        {p.engine && <div><small>Топливо</small><b>{p.engine.fuel_l} л</b></div>}
      </div>
      <div style={{ display: 'grid', gap: '10px' }}>
        <Stat label="Отзывчивость" v={f.bars.agility} value={f.bars.agility} />
        <Stat label="Скорость" v={f.bars.speed} value={f.bars.speed} />
        <Stat label="Выносливость" v={f.bars.endurance} value={f.bars.endurance} />
        <Stat label="Сложность" v={f.bars.difficulty} value={`${p.difficulty}/5`} />
      </div>
      <div><div class="eyebrow" style={{ marginBottom: '8px' }}>Режимы полёта</div>
        <div class="chips">{f.modes.map((m) => <span class={`chip${m === p.fc.default_mode ? ' on' : ''}`} style={{ cursor: 'default' }}>{modeName(m)}</span>)}</div></div>
    </div>
  );
}

function DronePicker({ only }: { only?: (d: DronePreset) => boolean }) {
  const [tab, setTab] = useState<DroneTab>('all');
  const s = settings.value, p = preset(s.drone);
  if (!p) return null;
  const list = ui.presets.value.filter((d) => (tab === 'all' || droneTab(d) === tab) && (!only || only(d)));
  return (
    <div class="dlayout">
      <div>
        <Chips value={tab} options={DRONE_TABS} onChange={setTab} />
        <div class="stage" style={{ marginTop: '14px' }}><div class="ring" /><DroneImg id={p.id} alt={droneTitle(p)} /></div>
        <div class="carousel">{list.map((d) => (
          <button class={`thumb${d.id === p.id ? ' on' : ''}`} aria-pressed={d.id === p.id} onClick={() => updateSettings((x) => { x.drone = d.id; })}>
            <DroneImg id={d.id} /><div>{droneTitle(d)}</div></button>))}
        </div>
      </div>
      <DroneSpec p={p} />
    </div>
  );
}

export function DronesScreen() {
  const s = settings.value, p = preset(s.drone);
  const race = ui.playMode.value === 'race';
  const mapName = MAPS.find((m) => m.id === s.map)?.name ?? s.map;
  const best = p ? bestLap(s.map, p.id) : Infinity;
  const ghost = race && p && isFinite(best) && hasGhost(s.map, p.id);
  const B = (x: string) => <b style={{ color: 'var(--text)' }}>{x}</b>;
  return (
    <div class="scr">
      <div class="page">
        <BackBtn />
        <div class="head"><div><div class="eyebrow">{race ? `Гонка · ${mapName} · 10 ворот` : `${mapName} · шаг 2 из 2`}</div><div class="h2" style={{ marginTop: '6px' }}>Выбери дрон</div></div></div>
        <DronePicker only={race ? raceable : undefined} />
      </div>
      <div class="footer-cta">
        {race ? <div class="cond">
          <label>Пропуск ворот<span class="seg">
            <button class={s.gameplay.gateMiss === 'penalty' ? 'on' : ''} onClick={() => updateSettings((x) => { x.gameplay.gateMiss = 'penalty'; })}>+{MISS_PENALTY_S} с за ворота</button>
            <button class={s.gameplay.gateMiss === 'dnf' ? 'on' : ''} onClick={() => updateSettings((x) => { x.gameplay.gateMiss = 'dnf'; })}>незачёт круга</button></span></label>
          <span class="mute" style={{ fontSize: '13px' }}>{isFinite(best) ? <>Лучший круг: <b class="mono" style={{ color: 'var(--text)' }}>{fmtLap(best)}</b>{ghost ? ' · призрак есть' : ' · призрак появится после нового рекорда'}</> : 'Кругов ещё нет — первый станет призраком.'}</span>
        </div> : <div class="mute" style={{ fontSize: '13px', maxWidth: '560px' }}>Совет: начни с камерного дрона в режиме {B('Normal')}, затем переходи к FPV в {B('Angle')}.
          {p && isFinite(best) && <> Лучший круг: <b class="mono" style={{ color: 'var(--text)' }}>{fmtLap(best)}</b></>}</div>}
        <div class="acts"><button class="mbtn ghost" onClick={() => go('hangar')}>Ангар · настройка</button><button class="mbtn primary" autoFocus onClick={launch}>{race ? 'На старт' : 'Взлёт'}</button></div>
      </div>
    </div>
  );
}

export function HangarScreen() {
  const s = settings.value, p = preset(s.drone);
  if (!p) return <div class="scr" />;
  const r = ratesFor(p.id);
  const fpvCam = p.camera.type === 'fpv';
  const uptilt = s.drones[p.id]?.uptilt ?? p.camera.uptilt_deg ?? 0;
  return (
    <div class="scr">
      <div class="page">
        <BackBtn />
        <div class="head"><div><div class="eyebrow">Ангар</div><div class="h2" style={{ marginTop: '6px' }}>Настройка дрона</div></div></div>
        <DronePicker />
          <div class="cards" style={{ marginTop: '18px' }}>
            {r && <div class="mcard glass"><div class="h3">Rates · {r.value.type.toUpperCase()}</div>
              <RatesEditor value={r.value} base={r.base} onChange={(v) => setRates(p.id, v)} /></div>}
            <div class="mcard glass"><div class="h3">Камера</div>
              {fpvCam ? <>
                <Slider label="Уптилт" min={-10} max={60} step={1} value={uptilt} fmt={(v) => `${v}°`}
                  onInput={(v) => updateSettings((x) => { (x.drones[p.id] ??= {}).uptilt = v; })} />
                <p>Наклон FPV-камеры вверх: больше уптилт — быстрее полёт с горизонтом в кадре. В полёте — V / B.</p>
                <Opt title="Задержка видео" hint={`${p.camera.latency_ms} мс · ${(p.camera as { link?: string }).link ?? ''}`}><span class="mono">{p.camera.fov_deg}° FOV</span></Opt>
              </> : <p>Камера на подвесе / в носу: угол наклона — колесом мыши или V / B в полёте. Rates не нужны — стики задают скорость.</p>}
            </div>
          </div>
      </div>
      <div class="footer-cta"><div /><div class="acts"><button class="mbtn primary" onClick={launch}>Взлёт</button></div></div>
    </div>
  );
}

export function AcademyScreen() {
  const res = progress.value.lessons;
  const stars = LESSONS.reduce((a, l) => a + (res[l.id]?.stars ?? 0), 0);
  const done = LESSONS.filter((l) => (res[l.id]?.stars ?? 0) > 0).length;
  return (
    <div class="scr"><div class="page">
      <BackBtn />
      <div class="eyebrow">Академия</div><div class="h2" style={{ marginTop: '6px' }}>Путь пилота</div>
      <div class="progress"><div class="bar" style={{ flex: 1, height: '8px' }}><i style={{ width: `${(done / LESSONS.length) * 100}%` }} /></div>
        <span class="mono">{done} / {LESSONS.length}</span><span class="stars">★ {stars}<i> / {LESSONS.length * 3}</i></span></div>
      <div class="lessons">{LESSONS.map((l, i) => {
        const r = res[l.id], st = r?.stars ?? 0;
        const open = lessonUnlocked(l.id, (id) => res[id]?.stars ?? 0);
        return (
          <button class={`lesson${st ? ' done' : ''}${open ? '' : ' lock'}`} disabled={!open} aria-disabled={!open}
            onClick={() => ui.launch?.({ map: l.map, drone: l.drone, lesson: l.id })}>
            <span class="n">{String(i + 1).padStart(2, '0')} · {droneTitle(preset(l.drone) ?? ({ name: l.drone, id: l.drone } as DronePreset))}</span>
            <span class="h3">{open ? '' : '🔒 '}{l.title}</span><span class="mute" style={{ fontSize: '13px', lineHeight: 1.5, flex: 1 }}>{open ? l.text : 'Откроется после предыдущего урока'}</span>
            <span class="row2"><Stars n={st} />{r && isFinite(r.best) && <span class="best">{fmtLap(r.best)}</span>}</span>
          </button>);
      })}</div>
    </div></div>
  );
}

interface Manifest { drones: { name: string; source: string }[]; textures: Record<string, { source?: string }>; props: Record<string, { source?: string }>; hdri: string[] }

export function CreditsScreen() {
  const [m, setM] = useState<Manifest | null>(null);
  useEffect(() => { fetch(`${ASSETS}manifest.json`).then((r) => r.json()).then(setM, () => {}); }, []);
  const count = (o: Record<string, { source?: string }>) => Object.values(o).reduce<Record<string, number>>((a, x) => { const k = x.source ?? '—'; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  return (
    <div class="scr"><div class="page">
      <BackBtn />
      <div class="eyebrow">Титры</div><div class="h2" style={{ marginTop: '6px', marginBottom: '20px' }}>DroneSim v{version}</div>
      <div class="credits">
        <div><b>Движок</b> — three.js (MIT), Rapier3D (Apache-2.0), Preact + Signals (MIT), Vite, Capacitor (MIT)</div>
        <div><b>Шрифты</b> — Manrope, JetBrains Mono (SIL OFL 1.1)</div>
        <div><b>Физика и полётные контроллеры</b> — собственная модель по открытым данным Betaflight, PX4, ArduPilot</div>
        <div><b>Звук</b> — процедурный синтез моторов и ветра (собственный)</div>
        {m && <>
          {m.drones.filter((d) => d.source !== 'custom').map((d) => <div><b>{d.name}</b> — {d.source.replace(/^gazebo:/, 'Gazebo Fuel ')}</div>)}
          <div><b>Остальные модели дронов и карты</b> — собственные (Blender, tools/blender)</div>
          {Object.entries(count(m.textures)).map(([s, n]) => <div><b>Текстуры</b> — {s}: {n}</div>)}
          {Object.entries(count(m.props)).map(([s, n]) => <div><b>Пропсы</b> — {s}: {n}</div>)}
          <div><b>HDRI-небо</b> — Poly Haven (CC0): {m.hdri.length}</div>
        </>}
      </div>
    </div></div>
  );
}
