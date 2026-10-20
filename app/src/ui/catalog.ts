// Menu copy: maps, drone classes and descriptions, flight-mode names, academy lessons (PLAN.md 7, 8.1, 9).
// Physics numbers stay in drones.json — here only what the menus say about them.
import type { DronePreset } from '../sim/presets';

export interface MapInfo {
  id: string; name: string; blurb: string; tags: MapTag[]; difficulty: number; weather: string;
  /** in this build (vite.config SHIPPED_MAPS / MOBILE_MAPS); the others load in dev only */
  shipped: boolean;
}
declare const __SHIPPED_MAPS__: string[];
const IN_BUILD: string[] | null = typeof __SHIPPED_MAPS__ !== 'undefined' ? __SHIPPED_MAPS__ : null;
export type MapTag = 'open' | 'bando' | 'city' | 'track';
export const MAP_TAGS: { id: MapTag | 'all'; label: string }[] = [
  { id: 'all', label: 'Все' }, { id: 'open', label: 'Открытые' }, { id: 'bando', label: 'Бандо' }, { id: 'city', label: 'Город' }, { id: 'track', label: 'Трассы' },
];

const MAP_LIST: MapInfo[] = [
  { id: 'training_field', name: 'Полигон', blurb: 'Поле 500×500 м · ВПП · 10 ворот · ангар', tags: ['open', 'track'], difficulty: 1, weather: 'Ясно', shipped: true },
  { id: 'parking_garage', name: 'Паркинг', blurb: '5 уровней · пандусы · колонны', tags: ['bando', 'city'], difficulty: 2, weather: 'Пасмурно', shipped: true },
  { id: 'abandoned_factory', name: 'Заброшенный завод', blurb: 'Цех · труба 50 м · дырявая крыша', tags: ['bando'], difficulty: 3, weather: 'Закат', shipped: false },
  { id: 'ruined_district', name: 'Разрушенный квартал', blurb: 'Панельки · обрушения · дворы', tags: ['city', 'bando'], difficulty: 4, weather: 'Пыль', shipped: false },
];
export const MAPS: MapInfo[] = MAP_LIST.map((m) => ({ ...m, shipped: IN_BUILD ? IN_BUILD.includes(m.id) : m.shipped }));

export type DroneTab = 'all' | 'fpv' | 'strike' | 'camera' | 'dev' | 'wing';
export const DRONE_TABS: { id: DroneTab; label: string }[] = [
  { id: 'all', label: 'Все' }, { id: 'fpv', label: 'FPV' }, { id: 'strike', label: 'Ударные' }, { id: 'camera', label: 'Камерные' }, { id: 'dev', label: 'Dev / PX4' }, { id: 'wing', label: 'Крылья' },
];
export const droneTab = (p: DronePreset): DroneTab =>
  p.warhead ? 'strike' : p.class === 'fpv' ? 'fpv' : p.class.startsWith('camera') ? 'camera' : p.class.startsWith('dev') ? 'dev' : 'wing';

export const DRONE_TEXT: Record<string, { title?: string; kind: string; text: string }> = {
  fpv_5in_freestyle: { kind: 'FPV · Betaflight', text: 'Фристайл-сетап: 2306 1750KV, 6S, экшн-камера сверху. Резкий, точный, мгновенный панч.' },
  fpv_5in_racer: { kind: 'FPV · Betaflight', text: 'Лёгкий гоночный квад: уптилт 45°, аналоговое видео с минимальной задержкой.' },
  fpv_7in_longrange: { kind: 'FPV · Betaflight + GPS', text: 'Li-ion, дальняя связь, GPS Rescue. Дальние полёты и управление батареей.' },
  fpv_10in_heavy: { kind: 'FPV · грузовой', text: 'Поднимает до 1.5 кг груза. Инерционный, сильный пропвош — доставка в зону.' },
  cinewhoop_3in: { title: 'Cinewhoop 3"', kind: 'FPV · съёмка', text: 'Пропеллеры в кольцах. Плавные пролёты в помещениях и рядом с людьми.' },
  camera_drone_fold: { title: 'Камерный дрон (класс Mavic)', kind: 'GPS · Cine / Normal / Sport', text: 'Отпустил стики — висит. Подвес, RTH, датчики препятствий, ATTI при потере GPS.' },
  parrot_bebop_2: { kind: 'GPS · Wi-Fi', text: 'Дрон для смартфона: лёгкий, цифровая стабилизация картинки.' },
  x500: { title: 'Holybro X500 V2', kind: 'PX4', text: 'Платформа разработчиков: Position, Altitude, Stabilized, RTL. Параметры моторов из PX4.' },
  iris_with_standoffs: { title: '3DR Iris+', kind: 'ArduPilot', text: 'Классика ArduPilot: Loiter, AltHold, Stabilize с ручным газом, RTL.' },
  typhoon_h480: { title: 'Typhoon H480 (гекса)', kind: 'GPS · гексакоптер', text: 'Шесть моторов: долетит и сядет даже при отказе одного (K).' },
  standard_vtol: { title: 'VTOL-крыло X8', kind: 'PX4 VTOL', text: 'Вертикальный взлёт, переход в самолёт, полёт по маршруту, вертикальная посадка.' },
  fpv_7in_kamikaze: { title: 'FPV 7" камикадзе', kind: 'FPV · ударный', text: 'Заряд 0.6 кг под рамой: тяжелее и ленивее обычной «семёрки». Подрыв — E / RB / кнопка, или сам при ударе быстрее 6 м/с.' },
  fpv_10in_kamikaze: { title: 'FPV 10" камикадзе', kind: 'FPV · ударный, тяжёлый', text: 'Заряд 1.4 кг: инерционный, долго тормозит, батарея садится быстро. Контактный взрыватель от 6 м/с.' },
  shahed_136_strike: { title: 'Шахед-136 (ударный)', kind: 'Fixed-wing · камикадзе', text: 'Старт с направляющей, маршрут, пикирование до 45°. Без парашюта. Взрыв при касании на скорости или по кнопке.' },
  delta_wing_lm: { title: 'Дельта-крыло', kind: 'Fixed-wing FBW', text: 'Учебная модель полёта планера: старт с направляющей, крейсер, ветер, маршрут, парашют.' },
};

export const droneTitle = (p: DronePreset) => DRONE_TEXT[p.id]?.title ?? p.name;

const MODE_NAME: Record<string, string> = {
  acro: 'Acro', angle: 'Angle', horizon: 'Horizon', turtle: 'Turtle', gps_rescue: 'GPS Rescue',
  cine: 'Cine', normal: 'Normal', sport: 'Sport', atti: 'ATTI', rth: 'RTH', smart: 'Smart', home: 'Home',
  position: 'Position', altitude: 'Altitude', stabilized: 'Stabilized', mission: 'Mission', rtl: 'RTL',
  stabilize: 'Stabilize', althold: 'AltHold', loiter: 'Loiter', auto: 'Auto', land: 'Land',
  mc_position: 'MC Position', transition: 'Переход', fw_position: 'FW Position', fbw_a: 'FBW-A', cruise: 'Cruise', waypoints: 'Waypoints',
};
export const modeName = (m: string) => MODE_NAME[m] ?? m.toUpperCase();

/** Menu facts derived from the preset (reference values from DRONES.md). */
export function droneFacts(p: DronePreset) {
  const r = (p.reference ?? {}) as { top_speed_kmh?: number; flight_time_min?: [number, number]; twr?: number };
  const ft = r.flight_time_min;
  const mass = p.mass < 1 ? `${Math.round(p.mass * 1000)} г` : `${+p.mass.toFixed(2)} кг`;
  return {
    mass, twr: r.twr ? String(r.twr) : '—', speed: r.top_speed_kmh ? `${r.top_speed_kmh} км/ч` : '—',
    time: ft ? `${ft[0]}–${ft[1]} мин` : '—',
    // 0..100 bars: responsiveness ~ TWR, speed, endurance, difficulty (1..5)
    bars: {
      agility: Math.round(Math.min(100, ((r.twr ?? 2) / 13) * 100)),
      speed: Math.round(Math.min(100, ((r.top_speed_kmh ?? 50) / 190) * 100)),
      endurance: Math.round(Math.min(100, (((ft ? (ft[0] + ft[1]) / 2 : 5)) / 60) * 100)),
      difficulty: Math.round((p.difficulty / 5) * 100),
    },
    modes: p.fc.modes,
  };
}

export interface LessonInfo { id: string; title: string; text: string; drone: string; map: string }
/** Academy path (PLAN.md 8.1); the lesson scripts are in game/academy/lessons.ts. */
export const LESSONS: LessonInfo[] = [
  { id: 'sticks', title: 'Пульт и стики', text: 'Что делает каждый стик, арминг, режимы', drone: 'camera_drone_fold', map: 'training_field' },
  { id: 'hover', title: 'Висение', text: 'Взлёт, удержание в круге, посадка на «H»', drone: 'camera_drone_fold', map: 'training_field' },
  { id: 'orient', title: 'Ориентация', text: 'Носом к себе, восьмёрка, облёт столба', drone: 'camera_drone_fold', map: 'training_field' },
  { id: 'atti', title: 'ATTI без GPS', text: 'Ветер сносит — держи позицию сам', drone: 'camera_drone_fold', map: 'training_field' },
  { id: 'film', title: 'Съёмка', text: 'Ровная орбита и плавный reveal', drone: 'camera_drone_fold', map: 'training_field' },
  { id: 'angle', title: 'FPV · Angle', text: 'Ворота и слалом с самовыравниванием', drone: 'cinewhoop_3in', map: 'training_field' },
  { id: 'acro_thr', title: 'Acro · газ', text: 'Удержание высоты без автоматики', drone: 'fpv_5in_freestyle', map: 'training_field' },
  { id: 'acro_turn', title: 'Acro · повороты', text: 'Координированный разворот, split-S', drone: 'fpv_5in_freestyle', map: 'training_field' },
  { id: 'tricks', title: 'Трюки', text: 'Flip, roll, power loop, split-S', drone: 'fpv_5in_freestyle', map: 'training_field' },
  { id: 'bando', title: 'Бандо', text: 'Окна, гапы, лестницы, пропвош', drone: 'fpv_5in_freestyle', map: 'parking_garage' },
  { id: 'long_range', title: 'Long Range', text: 'Батарея, RF-тени, GPS Rescue', drone: 'fpv_7in_longrange', map: 'training_field' },
  { id: 'wing', title: 'Крыло и VTOL', text: 'Переход, маршрут, посадка, снос ветром', drone: 'standard_vtol', map: 'training_field' },
];
