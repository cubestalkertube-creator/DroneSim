// Settings -> Controls (DESIGN.md screen 6, PLAN.md 5.3): connected device, live channel bars, calibration wizard,
// switch / button / knob assignment (like Betaflight's Receiver / Modes tabs), dead zone and expo. Transmitters
// without a calibration use a built-in profile (input/radios.ts); assigning a function copies it into the settings.
import { useEffect, useRef, useState } from 'preact/hooks';
import { AUX_FNS, KNOB_FNS, settings, updateSettings, type AuxFn, type KnobFn, type PadProfile, type StickAxis, type SwitchCal } from '../../core/settings';
import {
  CAL_STEPS, CalibrationWizard, KnobLearner, SwitchLearner, axisValue, calState, detectSwitch, knobValue, shape, switchOn, switchPos, usedAxes, type CalStep,
} from '../../input/calibration';
import { activePad, padName } from '../../input/input';
import { builtinProfile, controlName, isRC } from '../../input/radios';
import { modeName } from '../catalog';
import { Opt, Slider } from './bits';
import { ui } from './store';

interface PadState { id: string; name: string; mapping: string; axes: number[]; buttons: boolean[] }

/** Gamepad snapshot ~30 times a second while mounted. */
function usePad(): PadState | null {
  const [st, setSt] = useState<PadState | null>(null);
  useEffect(() => {
    const poll = () => {
      const p = activePad();
      setSt(p ? { id: p.id, name: padName(p.id), mapping: p.mapping, axes: Array.from(p.axes), buttons: p.buttons.map((b) => b.pressed) } : null);
    };
    const t = setInterval(poll, 33);
    poll();
    return () => clearInterval(t);
  }, []);
  return st;
}

/** While a modal listens to the pad, the flight and the menu navigation ignore it. */
function useListening() {
  useEffect(() => { calState.active = true; return () => { calState.active = false; }; }, []);
}

const CH: { id: StickAxis; label: string }[] = [{ id: 'throttle', label: 'Throttle' }, { id: 'yaw', label: 'Yaw' }, { id: 'pitch', label: 'Pitch' }, { id: 'roll', label: 'Roll' }];
export const AUX_LABEL: Record<AuxFn, string> = {
  arm: 'ARM', mode: 'Режим', turtle: 'Turtle', rth: 'RTH / домой', land: 'Посадка', reset: 'Рестарт', camera: 'Камера', fov: 'FOV камеры',
  next_spawn: 'Следующий старт', pause: 'Пауза / меню', mute: 'Звук вкл/выкл', detonate: 'Подрыв заряда',
};
const AUX_HINT: Partial<Record<AuxFn, string>> = {
  arm: 'уровень: включено = арм (газ внизу)',
  turtle: 'FPV: переворот после крэша (уровень, только в дизарме)',
  rth: 'GPS-дроны и крылья: включено = возврат домой',
  land: 'GPS: автопосадка; крыло: парашют',
  camera: 'тумблер пульта на 3 положения: FPV / 3-е лицо / с земли; кнопка — по кругу',
  detonate: 'камикадзе: подрыв по включению (только когда заряд взведён — в арме)',
};
export const KNOB_LABEL: Record<KnobFn, string> = { tilt: 'Наклон камеры', volume: 'Громкость' };
const KNOB_HINT: Record<KnobFn, string> = { tilt: 'крутилка: уптилт FPV 0–60° или подвес GPS-дрона', volume: 'крутилка / слайдер' };
const us = (v: number) => Math.round(1500 + v * 500); // as Betaflight shows channels (1000..2000 us)

/** Bipolar bar centred, unipolar from the left. */
const Track = ({ v, uni }: { v: number; uni?: boolean }) => {
  const style = uni ? { width: `${v * 100}%` } : { left: `${v < 0 ? 50 + v * 50 : 50}%`, width: `${Math.abs(v) * 50}%` };
  return <div class={`track${uni ? ' uni' : ''}`}><i style={style} /></div>;
};

const Buttons = ({ buttons }: { buttons: boolean[] }) => (
  <div class="ch">Кнопки<div class="mono" style={{ fontSize: '11px', letterSpacing: '2px', overflow: 'hidden' }}>
    {buttons.map((b, i) => <span title={`кнопка ${i}`} class={b ? 'ok' : ''}>{b ? '●' : '○'}</span>)}</div><b>{buttons.filter((b) => b).length}</b></div>
);

function Channels({ pad, prof }: { pad: PadState; prof: PadProfile | undefined }) {
  const c = settings.value.controls;
  if (!prof) {
    return <div class="channels">
      {pad.axes.map((a, i) => <div class="ch">Ось {i}<Track v={a} /><b>{a.toFixed(2)}</b></div>)}
      <Buttons buttons={pad.buttons} />
    </div>;
  }
  return <div class="channels">
    {CH.map(({ id, label }) => {
      const a = prof.axes[id], raw = pad.axes[a.index] ?? 0;
      const v = id === 'throttle' ? axisValue(raw, a, true) : shape(axisValue(raw, a, false), c.deadzone, c.expo);
      return <div class="ch">{label}<Track v={v} uni={id === 'throttle'} /><b>{id === 'throttle' ? Math.round(1000 + v * 1000) : us(v)}</b></div>;
    })}
    {(Object.entries(prof.aux) as [AuxFn, SwitchCal][]).map(([fn, sw]) => {
      if (fn === 'mode' && sw.kind !== 'button') {
        const pos = switchPos(sw, pad.axes, pad.buttons), n = sw.kind === 'buttons' ? sw.states?.length ?? 3 : 3;
        return <div class="ch">{AUX_LABEL[fn]}<Track v={pos < 0 ? 0 : n > 1 ? (2 * pos) / (n - 1) - 1 : 0} /><b>{pos < 0 ? '…' : `${pos + 1}/${n}`}</b></div>;
      }
      const on = switchOn(sw, pad.axes, pad.buttons);
      return <div class="ch">{AUX_LABEL[fn]}<Track v={on ? 1 : 0} uni /><b class={on ? 'ok' : ''}>{on ? 'ВКЛ' : 'выкл'}</b></div>;
    })}
    {(Object.entries(prof.knobs ?? {}) as [KnobFn, PadProfile['axes']['yaw']][]).map(([fn, k]) => {
      const v = knobValue(pad.axes[k.index] ?? 0, k);
      return <div class="ch">{KNOB_LABEL[fn]}<Track v={v} uni /><b>{Math.round(v * 100)}%</b></div>;
    })}
    {pad.buttons.length > 0 && <Buttons buttons={pad.buttons} />}
  </div>;
}

const STEP_TEXT: Record<CalStep, [string, string]> = {
  extremes: ['Стики по кругу', 'Подвигай оба стика по кругу до упоров несколько раз — запоминаем ход каждой оси. Тумблеры и крутилки пока не трогай. Затем «Далее».'],
  center: ['Центр', 'Отпусти стики в центр, газ — в самый низ (у геймпада — просто отпусти). Затем «Далее».'],
  throttle: ['Газ', 'Плавно подними газ вверх до упора.'],
  yaw: ['Рыскание', 'Отклони стик рыскания вправо.'],
  pitch: ['Тангаж', 'Отклони тангаж от себя (вперёд).'],
  roll: ['Крен', 'Отклони крен вправо.'],
  arm: ['Тумблер ARM', 'Переключи тумблер арма в положение «включено» или нажми кнопку арма. Можно пропустить.'],
  mode: ['Тумблер режимов', 'Переведи тумблер режимов по всем положениям по очереди: 1 → 2 → 3 (Acro / Angle / Horizon). У 2-позиционного — туда и «Далее». Можно пропустить.'],
  tilt: ['Крутилка камеры', 'Если есть крутилка или слайдер (VrA, S1…) — покрути от упора до упора: она будет наклонять камеру. Затем «Далее» или «Пропустить».'],
  done: ['Готово', 'Профиль сохранён для этого устройства. Проверь полоски каналов: газ вверх, рыскание/крен вправо и тангаж от себя — вправо. Остальные тумблеры и кнопки назначь ниже.'],
};

function Wizard({ pad, onClose }: { pad: PadState; onClose: () => void }) {
  const wz = useRef(new CalibrationWizard(pad.id, pad.mapping !== 'standard')).current;
  const [, tick] = useState(0);
  useListening();
  useEffect(() => {
    if (wz.step === 'done') return;
    if (wz.sample(pad.axes, pad.buttons) && (wz.step as CalStep) === 'done') save();
    tick((n) => n + 1);
  }, [pad]);
  const save = () => {
    const p = wz.result();
    if (p) updateSettings((s) => { s.controls.pads[pad.id] = p; });
  };
  const next = () => { wz.next(); if (wz.step === 'done') save(); tick((n) => n + 1); };
  const [title, text] = STEP_TEXT[wz.step];
  const idx = CAL_STEPS.indexOf(wz.step);
  const optional = wz.step === 'arm' || wz.step === 'mode' || wz.step === 'tilt';
  return (
    <div class="modal" role="dialog" aria-label="Калибровка">
      <div class="mcard glass">
        <div class="eyebrow">Калибровка · {pad.name}</div>
        <div class="steps">{CAL_STEPS.slice(0, -1).map((_, i) => <i class={i < idx || wz.step === 'done' ? 'on' : ''} />)}</div>
        <div class="big">{title}</div><p>{text}</p>
        {wz.step === 'extremes' && <div class="channels">
          {pad.axes.map((a, i) => {
            const lo = wz.min[i] ?? a, hi = wz.max[i] ?? a;
            return <div class="ch">Ось {i}<div class="track"><i style={{ left: `${(lo + 1) * 50}%`, width: `${(hi - lo) * 50}%`, opacity: 0.45 }} />
              <i style={{ left: `${(a + 1) * 50 - 1}%`, width: '2%', background: 'var(--accent)' }} /></div><b>{(hi - lo).toFixed(2)}</b></div>;
          })}
        </div>}
        {wz.step === 'mode' && wz.pending && <p class="mono ok">Положения найдены — переключи в следующее или «Далее».</p>}
        {wz.step === 'tilt' && <div class="channels"><div class="ch">Ход<Track v={Math.min(1, wz.knobRange / 1.6)} uni /><b>{Math.round(Math.min(1, wz.knobRange / 1.6) * 100)}%</b></div></div>}
        {wz.step === 'done' && <Channels pad={pad} prof={settings.value.controls.pads[pad.id]} />}
        {(wz.step === 'throttle' || wz.step === 'yaw' || wz.step === 'pitch' || wz.step === 'roll') && <p class="mono">
          Найдено: {CH.filter((c) => wz.axes[c.id]).map((c) => `${c.label} → ось ${wz.axes[c.id]!.index}${wz.axes[c.id]!.invert ? ' (инв.)' : ''}`).join(' · ') || '—'}</p>}
        <div class="btnrow">
          {wz.step !== 'done' && <button class="mbtn primary small" disabled={!wz.canNext} onClick={next}>{optional && !wz.pending ? 'Пропустить' : 'Далее'}</button>}
          <button class={`mbtn ${wz.step === 'done' ? 'primary' : 'ghost'} small`} data-close onClick={onClose}>{wz.step === 'done' ? 'Готово' : 'Отмена'}</button>
        </div>
      </div>
    </div>
  );
}

/** Settings get their own copy of the built-in profile before the first change. */
function ownProfile(pad: PadState, prof: PadProfile) {
  updateSettings((s) => { if (!s.controls.pads[pad.id]) s.controls.pads[pad.id] = structuredClone(prof); });
}

/** Assign one switch function to the next switch flip / button press (the mode: all positions). */
function Assign({ pad, prof, fn, onClose }: { pad: PadState; prof: PadProfile; fn: AuxFn; onClose: () => void }) {
  const base = useRef({ axes: pad.axes, buttons: pad.buttons }).current;
  // sticks and knobs are never switches; axis switches may drive several functions
  const exclude = useRef(usedAxes({ axes: prof.axes, aux: {}, knobs: prof.knobs })).current;
  const multi = fn === 'mode' || (fn === 'camera' && pad.mapping !== 'standard');
  const learner = useRef(multi ? new SwitchLearner(base.axes, base.buttons, exclude, pad.mapping !== 'standard') : null).current;
  const [pending, setPending] = useState(false);
  useListening();
  const save = (sw: SwitchCal) => { ownProfile(pad, prof); updateSettings((s) => { s.controls.pads[pad.id].aux[fn] = sw; }); onClose(); };
  useEffect(() => {
    if (learner) {
      const sw = learner.feed(pad.axes, pad.buttons);
      if (sw) save(sw); else setPending(!!learner.result());
      return;
    }
    const sw = detectSwitch(base.axes, base.buttons, pad.axes, pad.buttons, exclude);
    if (sw) save(sw);
  }, [pad]);
  return (
    <div class="modal" role="dialog">
      <div class="mcard glass">
        <div class="eyebrow">Назначение · {AUX_LABEL[fn]}</div>
        <div class="big">{multi ? 'Пройди тумблером все положения' : 'Переключи тумблер или нажми кнопку'}</div>
        <p>{fn === 'camera' && multi ? 'Трёхпозиционный тумблер: 1 → 2 → 3 = FPV / 3-е лицо / с земли. Двухпозиционный — туда и «Сохранить». Кнопка — смена камеры по кругу.'
          : fn === 'mode' ? 'Трёхпозиционный тумблер: 1 → 2 → 3 = Acro / Angle / Horizon (у GPS-дронов — первые три режима). Двухпозиционный — туда и «Сохранить». Кнопка геймпада — следующий режим по кругу.'
          : fn === 'arm' ? 'Тумблер: включено = арм, выключено = дизарм (газ должен быть внизу).'
            : fn === 'turtle' || fn === 'rth' ? 'Тумблер пульта — уровень (включено = режим включён), кнопка геймпада — переключение.'
              : 'Срабатывает при включении тумблера или нажатии кнопки. Подойдёт и любое положение 3-позиционного тумблера.'}</p>
        {pending && <p class="mono ok">Положения найдены — продолжай или «Сохранить».</p>}
        <div class="btnrow">
          {learner && <button class="mbtn primary small" disabled={!pending} onClick={() => { const r = learner.result(); if (r) save(r); }}>Сохранить</button>}
          {prof.aux[fn] && <button class="mbtn ghost small" onClick={() => { ownProfile(pad, prof); updateSettings((s) => { delete s.controls.pads[pad.id].aux[fn]; }); onClose(); }}>Снять назначение</button>}
          <button class="mbtn ghost small" data-close onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  );
}

/** Assign a knob / slider: turn it end to end, then save. */
function AssignKnob({ pad, prof, fn, onClose }: { pad: PadState; prof: PadProfile; fn: KnobFn; onClose: () => void }) {
  const others = { ...prof.knobs }; delete others[fn];
  const learner = useRef(new KnobLearner(usedAxes({ axes: prof.axes, aux: prof.aux, knobs: others }))).current;
  const [range, setRange] = useState(0);
  useListening();
  useEffect(() => { learner.feed(pad.axes); setRange(learner.range); }, [pad]);
  const v = Math.min(1, range / 1.6);
  return (
    <div class="modal" role="dialog">
      <div class="mcard glass">
        <div class="eyebrow">Назначение · {KNOB_LABEL[fn]}</div>
        <div class="big">Покрути крутилку от упора до упора</div>
        <p>{KNOB_HINT[fn]}. Ход заполнится — жми «Сохранить».</p>
        <div class="channels"><div class="ch">Ход<Track v={v} uni /><b>{Math.round(v * 100)}%</b></div></div>
        <div class="btnrow">
          <button class="mbtn primary small" disabled={!learner.result()} onClick={() => {
            const r = learner.result();
            if (r) { ownProfile(pad, prof); updateSettings((s) => { (s.controls.pads[pad.id].knobs ??= {})[fn] = r; }); }
            onClose();
          }}>Сохранить</button>
          {prof.knobs?.[fn] && <button class="mbtn ghost small" onClick={() => { ownProfile(pad, prof); updateSettings((s) => { delete s.controls.pads[pad.id].knobs?.[fn]; }); onClose(); }}>Снять назначение</button>}
          <button class="mbtn ghost small" data-close onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  );
}

const swLabel = (pad: PadState, prof: PadProfile, fn: AuxFn) => {
  const s = prof.aux[fn];
  if (!s) return '—';
  const name = controlName(pad, s);
  if (s.kind === 'buttons') return `${name} · ${s.states?.length ?? 0} пол.`;
  if (s.kind === 'axis' && fn !== 'mode' && !builtinProfile(pad)?.axisNames?.[s.index]) return `${name} ${s.on < 0 ? '(−)' : '(+)'}`;
  return name;
};

type Modal = '' | 'cal' | { fn: AuxFn } | { knob: KnobFn };

export function ControlsSection() {
  const pad = usePad();
  const [modal, setModal] = useState<Modal>('');
  const c = settings.value.controls;
  const own = pad ? c.pads[pad.id] : undefined;
  const builtin = pad && !own ? builtinProfile(pad) : null;
  const prof = own ?? builtin?.profile;
  const rc = !!pad && isRC(pad);
  return (
    <div class="cards">
      <div class="mcard glass">
        <div class="h3">{pad ? (builtin?.name ?? pad.name) : ui.touch ? 'Тач-стики' : 'Клавиатура и мышь'}
          {pad && <span class="chip"><span class="dot" />{rc ? 'RC-пульт · USB' : pad.mapping !== 'standard' ? 'USB HID' : 'Геймпад'}</span>}
          {pad && <span class="chip">{own ? 'калибровано' : builtin ? 'встроенный профиль' : 'по умолчанию'}</span>}</div>
        {pad ? <p>{own ? 'Свой профиль: порядок каналов, направления и тумблеры из калибровки.'
          : builtin ? builtin.notes
            : 'Mode 2: левый стик — газ (центр = 50 %) / рыскание, правый — тангаж / крен. A — арм, B — рестарт, Y — камера.'}
          {rc && ' В меню: тангаж — вверх/вниз, крен вправо — выбрать, влево — назад.'}</p>
          : <p>Подключи RC-пульт (EdgeTX/OpenTX → USB Joystick, FlySky → USB-эмулятор) или геймпад и пошевели стиком — он появится здесь.
            {ui.touch ? ' Раскладку тач-стиков меняй в паузе во время полёта.' : ' Клавиатура: W/S газ, A/D рыскание, стрелки — тангаж/крен, M — мышь как правый стик.'}</p>}
        {pad && <Channels pad={pad} prof={prof} />}
        {pad && <div class="btnrow">
          <button class="mbtn ghost small" onClick={() => setModal('cal')}>Калибровать</button>
          {own && <button class="mbtn ghost small" onClick={() => updateSettings((s) => { delete s.controls.pads[pad.id]; })}>{builtinProfile(pad) ? 'Вернуть встроенный' : 'Сбросить профиль'}</button>}
        </div>}
      </div>
      <div class="mcard glass">
        <div class="h3">Тумблеры, кнопки, крутилки</div>
        {prof ? <div style={{ marginTop: '8px' }}>
          {AUX_FNS.map((fn) => <Opt title={AUX_LABEL[fn]} hint={fn === 'mode' ? `положения: ${['acro', 'angle', 'horizon'].map(modeName).join(' / ')}` : AUX_HINT[fn]}>
            <button class="mbtn ghost small" onClick={() => setModal({ fn })}>{swLabel(pad!, prof, fn)}</button></Opt>)}
          {KNOB_FNS.map((fn) => <Opt title={KNOB_LABEL[fn]} hint={KNOB_HINT[fn]}>
            <button class="mbtn ghost small" onClick={() => setModal({ knob: fn })}>{prof.knobs?.[fn] ? `ось ${prof.knobs[fn]!.index}` : '—'}</button></Opt>)}
        </div> : <p>{pad ? 'Сначала откалибруй устройство — после этого любому тумблеру, кнопке или крутилке можно назначить арм, режимы, Turtle, RTH, посадку, рестарт, камеру, паузу и т. д.' : 'Нет подключённого пульта или геймпада.'}</p>}
        <div style={{ marginTop: '10px' }}>
          <Slider label="Мёртвая зона" min={0} max={0.15} step={0.005} value={c.deadzone} fmt={(v) => `${(v * 100).toFixed(1)}%`}
            onInput={(v) => updateSettings((s) => { s.controls.deadzone = v; })} />
          <Slider label="Expo стиков" min={0} max={0.8} step={0.01} value={c.expo} fmt={(v) => v.toFixed(2)}
            onInput={(v) => updateSettings((s) => { s.controls.expo = v; })} />
          <p>Dead zone и expo — для пультов и геймпадов с профилем (как на аппаратуре). Кривую самого дрона меняй в «Rates».</p>
        </div>
      </div>
      {pad && modal === 'cal' && <Wizard pad={pad} onClose={() => setModal('')} />}
      {pad && prof && typeof modal === 'object' && 'fn' in modal && <Assign pad={pad} prof={prof} fn={modal.fn} onClose={() => setModal('')} />}
      {pad && prof && typeof modal === 'object' && 'knob' in modal && <AssignKnob pad={pad} prof={prof} fn={modal.knob} onClose={() => setModal('')} />}
    </div>
  );
}
