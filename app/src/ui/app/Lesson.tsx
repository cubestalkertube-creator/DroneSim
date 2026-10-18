// Academy overlays (PLAN.md 8.1): the lesson panel during the flight (step, instruction, live detail, hold
// progress), the briefing on the "ready" screen and the result card with stars and metrics.
import { Stars } from './bits';
import { ui, type LessonUi } from './store';

/** Step panel over the OSD (top left, under the throttle line). */
export function LessonPanel() {
  const l = ui.lesson.value;
  if (!l || l.result) return null;
  return (
    <div class="lpanel glass">
      <div class="lhead"><span class="eyebrow">Урок · {l.title}</span><span class="mono">{Math.min(l.step + 1, l.total)} / {l.total}</span></div>
      <div class="ldots">{Array.from({ length: l.total }, (_, i) => <i class={i < l.step ? 'done' : i === l.step ? 'on' : ''} />)}</div>
      <div class="ltext">{l.text}</div>
      {l.sub && <div class="lsub mono">{l.sub}</div>}
      {l.progress > 0 && <div class="bar lbar"><i style={{ width: `${l.progress * 100}%` }} /></div>}
    </div>
  );
}

export function Goals({ l }: { l: LessonUi }) {
  return (
    <div class="lgoals">
      <div class="lgrow head"><span>Оценка</span><span><Stars n={2} /></span><span><Stars n={3} /></span></div>
      {l.goals.map((g) => <div class="lgrow"><span>{g.label}</span><b>{g.two}</b><b>{g.three}</b></div>)}
      <div class="mute" style={{ fontSize: '12px', marginTop: '6px' }}>★ — урок пройден; ★★ / ★★★ — все показатели в норме.</div>
    </div>
  );
}

/** Briefing block of the "ready" screen. */
export function LessonBrief({ l }: { l: LessonUi }) {
  return (
    <div class="lbrief">
      <p>{l.brief}</p>
      <Goals l={l} />
    </div>
  );
}

export function LessonResultCard() {
  const l = ui.lesson.value, h = ui.hooks;
  const r = l?.result;
  if (!l || !r) return null;
  const ok = r.state === 'done';
  return (
    <div class="ov"><div class="ovcard glass narrow lresult">
      <div class="eyebrow">Урок · {l.title}</div>
      <div class="h1">{ok ? 'Урок пройден' : 'Не получилось'}</div>
      {ok ? <div class="bigstars"><Stars n={r.stars} /></div> : <div class="mute">{r.reason} · шаг {l.step + 1} из {l.total}: {l.text}</div>}
      {ok && <div class="lgoals">
        <div class="lgrow head"><span>Показатель</span><span>Итог</span><span><Stars n={3} /></span></div>
        {r.lines.map((x) => <div class="lgrow"><span>{x.label}</span><b class={x.ok3 ? 'acc' : x.ok2 ? '' : 'warn'}>{x.value}</b><span class="mute">{x.three}</span></div>)}
      </div>}
      {ok && l.best > r.stars && <div class="mute" style={{ fontSize: '13px' }}>Лучший результат: <Stars n={l.best} /></div>}
      <nav class="pmenu">
        {ok && h?.next && <button autoFocus onClick={() => h.next!()}>Следующий урок →</button>}
        <button autoFocus={!ok || !h?.next} onClick={() => h?.retry?.()}>{ok ? 'Пройти ещё раз' : 'Попробовать снова'}</button>
        <button onClick={() => h?.exit()}>В Академию</button>
      </nav>
    </div></div>
  );
}
