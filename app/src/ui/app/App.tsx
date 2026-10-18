// Root of the Preact UI (PLAN.md 9): menu screens before the flight, overlays during it.
import { render } from 'preact';
import './menu.css';
import { AcademyScreen, CreditsScreen, DronesScreen, HangarScreen, MainMenu, MapsScreen, PlayScreen } from './Screens';
import { SettingsBody } from './Settings';
import { FlightOverlay } from './Flight';
import { BackBtn } from './bits';
import { installMenuNav } from './nav';
import { ui } from './store';

function SettingsScreen() {
  return (
    <div class="scr"><div class="page">
      <BackBtn />
      <div class="head"><div><div class="eyebrow">Настройки</div><div class="h2" style={{ marginTop: '6px' }}>Управление, rates, графика, звук</div></div></div>
      <SettingsBody />
    </div></div>
  );
}

function App() {
  switch (ui.screen.value) {
    case 'main': return <MainMenu />;
    case 'play': return <PlayScreen />;
    case 'maps': return <MapsScreen />;
    case 'drones': return <DronesScreen />;
    case 'hangar': return <HangarScreen />;
    case 'academy': return <AcademyScreen />;
    case 'settings': return <SettingsScreen />;
    case 'credits': return <CreditsScreen />;
    case 'flight': return <FlightOverlay />;
  }
}

export function mountUi(parent: HTMLElement) {
  const root = document.createElement('div');
  root.id = 'app';
  parent.append(root);
  installMenuNav();
  render(<App />, root);
}
