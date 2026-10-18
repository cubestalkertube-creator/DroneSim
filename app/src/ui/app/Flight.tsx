// Flight overlays: loading, "ready — take off" with the controls, pause (resume / restart / settings / controls /
// exit to menu). The OSD itself stays imperative (ui/hud.ts) — it updates every frame.
import { useEffect, useState } from 'preact/hooks';
import type { AuxFn, PadProfile } from '../../core/settings';
import { activePad, padProfile } from '../../input/input';
import { builtinProfile, controlName, isRC } from '../../input/radios';
import { AUX_LABEL, KNOB_LABEL } from './Controls';
import { SettingsBody } from './Settings';
import { BackBtn } from './bits';
import { setFlight, ui } from './store';
import { LessonBrief, LessonPanel, LessonResultCard } from './Lesson';

/** The connected transmitter and its profile (polled: it may be plugged in while the overlay is open). */
function useRc(): { pad: Gamepad; prof: PadProfile } | null {
  const get = () => { const p = activePad(); const prof = p && isRC(p) ? padProfile(p) : undefined; return p && prof ? { pad: p, prof } : null; };
  const [rc, setRc] = useState(get);
  useEffect(() => { const t = setInterval(() => setRc(get()), 500); return () => clearInterval(t); }, []);
  return rc;
}

/** Controls of a transmitter: sticks plus every switch / button / knob function of its profile. */
function RcHelp({ kind, pad, prof }: { kind: 'fpv' | 'gps' | 'plane'; pad: Gamepad; prof: PadProfile }) {
  const aux = (Object.entries(prof.aux) as [AuxFn, NonNullable<PadProfile['aux']['arm']>][])
    .filter(([fn]) => !(kind === 'fpv' && fn === 'rth') && !(kind !== 'fpv' && fn === 'turtle') && !(fn === 'detonate' && !ui.flight.value.warhead));
  const mode = kind === 'fpv' ? 'Acro / Angle / Horizon' : 'первые три режима дрона';
  return (
    <div class="grid">
      <div>
        <div class="k">Пульт<b>{builtinProfile(pad)?.name ?? pad.id.replace(/\(.*?\)/g, '').trim()}</b></div>
        <div class="k">Левый стик<b>{kind === 'fpv' ? 'газ (без пружины, как на FPV-пультах) · рыскание' : 'газ (центр = висение) · рыскание'}</b></div>
        <div class="k">Правый стик<b>тангаж · крен</b></div>
        <div class="k">Меню стиками<b>тангаж ▲▼ · крен вправо — выбрать · влево — назад</b></div>
        {kind === 'fpv' && <div class="k">Арм<b>газ в ноль, затем тумблер</b></div>}
        {kind === 'gps' && <div class="k">Запуск моторов<b>оба стика вниз и внутрь (DJI) · газ вниз + рыскание вправо (PX4/ArduPilot) · или тумблер</b></div>}
        {kind === 'gps' && <div class="k">Остановка моторов<b>на земле газ вниз 1 с</b></div>}
      </div>
      <div>
        {aux.map(([fn, sw]) => <div class="k">{fn === 'mode' ? `Режим (${mode})` : fn === 'camera' && sw.kind === 'buttons' ? 'Камера (FPV / 3-е лицо / с земли)' : AUX_LABEL[fn]}<b>{controlName(pad, sw)}</b></div>)}
        {Object.entries(prof.knobs ?? {}).map(([fn, k]) => <div class="k">{KNOB_LABEL[fn as keyof typeof KNOB_LABEL]}<b>канал {k!.index + 1}</b></div>)}
        <div class="k">Переназначить<b>Пауза → Настройки → Управление</b></div>
      </div>
    </div>
  );
}

function Help({ kind }: { kind: 'fpv' | 'gps' | 'plane' }) {
  const rc = useRc();
  if (rc) return <RcHelp kind={kind} pad={rc.pad} prof={rc.prof} />;
  if (ui.touch) return (
    <div class="grid">
      <div>
        <div class="k">Левый стик<b>{kind === 'fpv' ? 'газ (держится) · рыскание' : 'газ (центр = висение) · рыскание'}</b></div>
        <div class="k">Правый стик<b>тангаж · крен</b></div>
        <div class="k">Арм<b>свайп слайдера вправо · тап — дизарм</b></div>
      </div>
      <div>
        <div class="k">Режим полёта<b>кнопка справа вверху</b></div>
        <div class="k">Камера FPV / 3-е лицо / с земли<b>◉ Камера</b></div>
        <div class="k">После краша<b>⟲ Рестарт или Turtle</b></div>
        <div class="k">GPS-дроны<b>⌂ RTH</b></div>
        {ui.flight.value.warhead && <div class="k">Подрыв заряда (сам — при ударе на скорости)<b>✸ ПОДРЫВ</b></div>}
      </div>
    </div>
  );
  return (
    <div class="grid">
      <div>
        <div class="k">Газ{kind === 'fpv' ? ' (держится, как на пульте)' : ' (центр = висение)'}<b><kbd>W</kbd> <kbd>S</kbd>{kind === 'fpv' && <> · <kbd>X</kbd> сброс</>}</b></div>
        <div class="k">Рыскание<b><kbd>A</kbd> <kbd>D</kbd></b></div>
        <div class="k">Тангаж / крен<b><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> или <kbd>I</kbd><kbd>K</kbd><kbd>J</kbd><kbd>L</kbd></b></div>
        <div class="k">Быстрее / точнее<b><kbd>Shift</kbd> / <kbd>Ctrl</kbd></b></div>
        <div class="k">Мышь как правый стик (+колесо = газ)<b><kbd>M</kbd></b></div>
        <div class="k">Арм / дизарм{kind === 'fpv' ? ' (газ в ноль)' : ''}<b><kbd>Пробел</kbd></b></div>
      </div>
      <div>
        {kind === 'fpv' && <div class="k">Acro / Angle / Horizon<b><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></b></div>}
        {kind === 'gps' && <div class="k">Режимы · RTH · посадка<b><kbd>1</kbd>–<kbd>4</kbd> · <kbd>H</kbd> · <kbd>G</kbd></b></div>}
        {kind === 'plane' && <div class="k">Режимы · RTL · парашют (крыло)<b><kbd>1</kbd>–<kbd>4</kbd> · <kbd>H</kbd> · <kbd>G</kbd></b></div>}
        <div class="k">Камера FPV / 3-е лицо / с земли<b><kbd>C</kbd></b></div>
        <div class="k">{kind === 'fpv' ? 'Уптилт ± 5° · FOV · пропы в FPV' : 'Подвес ▲▼ · FOV'}<b><kbd>V</kbd> <kbd>B</kbd> · <kbd>F</kbd>{kind === 'fpv' && <> · <kbd>P</kbd></>}</b></div>
        <div class="k">Рестарт · след. точка старта · пауза<b><kbd>R</kbd> · <kbd>N</kbd> · <kbd>Esc</kbd></b></div>
        {kind === 'fpv' && <div class="k">Turtle (перевернуться после краша)<b><kbd>T</kbd>, затем арм и стик</b></div>}
        {ui.flight.value.warhead && <div class="k">Подрыв заряда (в арме; сам — при ударе на скорости)<b><kbd>E</kbd> · геймпад RB</b></div>}
        <div class="k">Звук · отказ мотора · отладка<b><kbd>U</kbd> · <kbd>K</kbd> · <kbd>F3</kbd></b></div>
        {kind === 'fpv' && <div class="k">Rates из Betaflight CLI<b><kbd>Ctrl</kbd>+<kbd>V</kbd> строки <code>set …</code></b></div>}
      </div>
    </div>
  );
}

export function FlightOverlay() {
  const f = ui.flight.value, h = ui.hooks;
  const rc = useRc(); // before the early returns: hooks keep their order
  const lesson = ui.lesson.value;
  if (f.phase === 'running') return lesson ? <LessonPanel /> : null;
  if (f.phase === 'result') return <LessonResultCard />;
  if (f.phase === 'loading') return (
    <div class="ov"><div class="ovcard glass">
      <div class="mlogo"><div class="mark">◆</div>DRONESIM</div>
      <div class="h1">{f.title || 'Загрузка'}</div><div class="mute">{f.sub || 'Физика электромеханики, батареи и ветра в реальном времени'}</div>
      <div class="loader"><i /></div><div class="mono mute" style={{ fontSize: '13px', marginTop: '12px' }}>{f.status}</div>
    </div></div>
  );
  if (f.page === 'settings') return (
    <div class="ov" style={{ placeItems: 'stretch' }}><div class="ovcard glass" style={{ width: 'min(1200px, 100%)', justifySelf: 'center' }}>
      <BackBtn label="Пауза" /><div class="h2">Настройки</div>
      <SettingsBody inFlight />
    </div></div>
  );
  const ready = f.phase === 'ready';
  return (
    <div class="ov"><div class={`ovcard glass${!ready && f.page === 'menu' ? ' narrow' : ''}`}>
      <div class="mlogo"><div class="mark">◆</div>DRONESIM</div>
      <div class="h1">{ready ? f.title : 'Пауза'}</div><div class="mute">{f.sub}</div>
      {f.page === 'help' ? <><Help kind={f.kind} /><button class="mbtn ghost" autoFocus onClick={() => setFlight({ page: 'menu' })}>← Назад</button></> : ready ? <>
        <div class="btnrow">
          <button class="mbtn primary" autoFocus onClick={() => h?.start()}>{lesson ? 'Начать урок' : 'Взлёт'}</button>
          {ui.touch && h?.editLayout && <button class="mbtn ghost" onClick={() => h.editLayout!()}>Раскладка стиков</button>}
          <button class="mbtn ghost" onClick={() => h?.exit()}>В меню</button>
          {!ui.touch && <span class="mute" style={{ alignSelf: 'center' }}>или <kbd>Enter</kbd>{rc && ' · крен вправо'}</span>}
        </div>
        {lesson && <LessonBrief l={lesson} />}
        <Help kind={f.kind} />
      </> : (
        <nav class="pmenu">
          <button autoFocus onClick={() => h?.start()}>Продолжить</button>
          <button onClick={() => { h?.restart(); h?.start(); }}>{lesson ? 'Начать урок заново' : 'Рестарт'}</button>
          <button onClick={() => setFlight({ page: 'settings' })}>Настройки</button>
          <button onClick={() => setFlight({ page: 'help' })}>Управление</button>
          {ui.touch && h?.editLayout && <button onClick={() => h.editLayout!()}>Раскладка стиков</button>}
          <button onClick={() => h?.exit()}>{lesson ? 'Выйти в Академию' : 'Выйти в меню'}</button>
        </nav>
      )}
    </div></div>
  );
}
