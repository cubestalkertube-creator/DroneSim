// DroneSim bootstrap: presets, the Preact UI (menus, ui/app) and the flight (game/flight.ts).
// ?map=<id>&drone=<id> skips the menus and loads that flight directly (dev, automated checks); &mode=race — the race.
import type { DronePreset } from './sim/presets';
import { ASSET_URL } from './render/world';
import { isTouch } from './platform/platform';
import { settings, updateSettings } from './core/settings';
import { mountUi } from './ui/app/App';
import { ui, type LaunchConfig } from './ui/app/store';
import { runFlight } from './game/flight';

const Q = new URLSearchParams(location.search);

async function main() {
  ui.touch = isTouch || Q.has('touch');
  document.body.classList.toggle('touch', ui.touch);
  const direct = Q.has('map') || Q.has('drone') || Q.has('lesson');
  if (direct) ui.screen.value = 'flight';
  const uiRoot = document.getElementById('ui')!;
  mountUi(uiRoot);
  const r = await fetch(ASSET_URL + 'presets/drones.json');
  if (!r.ok) throw new Error(`presets/drones.json: ${r.status}`);
  const presets = (await r.json() as { drones: DronePreset[] }).drones;
  ui.presets.value = presets;
  if (!presets.some((p) => p.id === settings.value.drone)) updateSettings((s) => { s.drone = presets[0].id; });

  let started = false;
  const launch = (c: LaunchConfig) => {
    if (started) return;
    started = true;
    runFlight(c, presets).catch(fail);
  };
  // lessons fly their own drone / map and do not change the free-flight choice
  ui.launch = (c) => { if (!c.lesson) updateSettings((s) => { s.map = c.map; s.drone = c.drone; }); launch(c); };
  if (direct) launch({ map: Q.get('map') ?? settings.value.map, drone: Q.get('drone') ?? settings.value.drone, lesson: Q.get('lesson') ?? undefined, mode: Q.get('mode') === 'race' ? 'race' : 'free' });
  else {
    // back from a lesson / a race: straight to the academy / the play screen (game/flight.ts exitToMenu)
    let back: string | null = null;
    try { back = sessionStorage.getItem('ds.screen'); sessionStorage.removeItem('ds.screen'); } catch { /* ignore */ }
    ui.screen.value = back === 'academy' || back === 'play' ? back : 'main';
  }
}

function fail(e: unknown) {
  console.error(e);
  const box = document.createElement('div');
  box.style.cssText = 'padding:40px;font-family:system-ui,sans-serif;color:#e8ecf2;pointer-events:auto';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:20px;color:#ff4d5e;margin-bottom:12px';
  title.textContent = 'Не удалось запустить симулятор';
  const hint = document.createElement('div');
  hint.textContent = 'Попробуйте перезагрузить страницу или вернуться в меню.';
  const link = document.createElement('a');
  link.href = './';
  link.textContent = 'В меню';
  link.style.cssText = 'display:inline-block;margin-top:16px;color:#c8ff2e';
  box.append(title, hint, link);
  // подробности (сообщение + стек) — под спойлером, чтобы можно было отдебажить и приложить к баг-репорту
  const det = document.createElement('details');
  det.style.cssText = 'margin-top:16px;max-width:900px';
  const sum = document.createElement('summary');
  sum.textContent = 'Подробности';
  sum.style.cssText = 'cursor:pointer;color:#9aa4b2';
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin-top:8px;color:#ff4d5e;white-space:pre-wrap;font-size:12px;user-select:text';
  pre.textContent = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e);
  det.append(sum, pre);
  box.append(det);
  document.getElementById('ui')!.replaceChildren(box);
}

main().catch(fail);
