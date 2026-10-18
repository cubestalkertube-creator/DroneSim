// The 12 academy lessons (PLAN.md 8.1): steps, targets and star criteria. Titles, drones and maps come from the
// menu catalog (ui/catalog.ts LESSONS) so the academy screen and the flight agree. Coordinates: game space
// (+Y up, -Z forward), metres; map facts (pads, flags, garage grid) are from tools/blender/map_builder.py.
import * as THREE from 'three';
import { LESSONS } from '../../ui/catalog';
import {
  angDiff, crossedGate, dist3, distH, gateQuat, noseTo, quatT,
  type Criterion, type LessonDef, type LessonEnv, type LessonFrame, type Step, type Target,
} from './runner';
import { TRICK_LABEL, type TrickName } from './tricks';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const f1 = (v: number) => v.toFixed(1);

// ------------------------------------------------------------------------------------------------ criteria
const timeC = (two: number, three: number): Criterion => ({ label: 'Время', get: (m) => m.time, fmt: (v) => `${v.toFixed(0)} с`, two, three });
const hitsC = (two: number, three: number): Criterion => ({ label: 'Столкновения', get: (m) => m.hits, fmt: (v) => `${v}`, two, three });
const landC = (two: number, three: number): Criterion => ({ label: 'Точность посадки', get: (m) => m.x.land ?? 99, fmt: (v) => `${v.toFixed(1)} м`, two, three });
const altC = (two: number, three: number): Criterion => ({ label: 'Отклонение высоты (RMS)', get: (m) => m.altRmse, fmt: (v) => `${v.toFixed(2)} м`, two, three });

// ------------------------------------------------------------------------------------------------ step builders
const arm = (gps: boolean): Step => ({
  text: gps ? 'Запусти моторы: {arm}' : 'Газ в ноль и арм: {arm}', stick: 'left',
  done: (f) => f.armed,
});

const takeoff = (alt: number, home: THREE.Vector3, gps: boolean): Step => ({
  text: gps ? `Левый стик вверх (газ) — взлёт на ${alt} м` : `Добавь газ — набери ${alt} м`, stick: 'left',
  targets: [{ kind: 'pad', c: home.clone(), r: 1.5 }],
  sub: (f, c) => `Высота ${f1(c.alt(f))} / ${alt} м`,
  done: (f, c) => f.armed && c.alt(f) >= alt - 0.3,
});

const goPoint = (text: string, c: THREE.Vector3, r: number, next?: THREE.Vector3, stick?: Step['stick']): Step => ({
  text, stick,
  targets: [{ kind: 'point', c, r }, ...(next ? [{ kind: 'point' as const, c: next, r: r * 0.6 }] : [])],
  sub: (f) => `До цели ${dist3(f.pos, c).toFixed(0)} м`,
  done: (f) => dist3(f.pos, c) < r,
});

/** touch down inside r of a pad; stores the landing offset (metric "land") */
const land = (text: string, pad: THREE.Vector3, r: number): Step => ({
  text, stick: 'left',
  targets: [{ kind: 'pad', c: pad, r }],
  sub: (f) => `До площадки ${distH(f.pos, pad).toFixed(1)} м · высота ${f1(Math.max(0, f.pos.y - pad.y))} м`,
  done: (f, c) => {
    const ok = f.landed && distH(f.pos, pad) < r;
    if (ok) c.m.x.land = distH(f.pos, pad);
    return ok;
  },
});

const disarm = (gps: boolean): Step => ({
  text: gps ? 'Держи газ внизу 1 с — моторы остановятся' : 'Дизарм: {arm}', stick: 'left',
  done: (f) => !f.armed,
});

/** stay inside a vertical cylinder (hover box) for `sec` seconds in total */
const hoverIn = (text: string, c: THREE.Vector3, r: number, alt: [number, number], sec: number, trackAlt: number): Step => ({
  text, stick: 'both', hold: sec, trackAlt,
  targets: [{ kind: 'pad', c, r }],
  sub: (f, k) => {
    const d = distH(f.pos, c), a = k.alt(f);
    return d > r ? `Вне круга: ${d.toFixed(1)} м от центра` : a < alt[0] ? `Ниже нормы: ${f1(a)} м` : a > alt[1] ? `Выше нормы: ${f1(a)} м` : `В круге · высота ${f1(a)} м`;
  },
  done: (f, k) => { const a = k.alt(f); return distH(f.pos, c) < r && a >= alt[0] && a <= alt[1]; },
});

const gateStep = (text: string, g: { c: THREE.Vector3; q: THREE.Quaternion; w: number; h: number }, next?: Target): Step => ({
  text, stick: 'right',
  targets: [{ kind: 'gate', ...g }, ...(next ? [next] : [])],
  sub: (f) => `До ворот ${dist3(f.pos, g.c).toFixed(0)} м`,
  done: (f, c) => crossedGate(c.prevPos, f.pos, g),
});

const trickStep = (name: TrickName, text: string): Step => ({
  text, stick: 'right',
  sub: (f, c) => `Высота ${c.alt(f).toFixed(0)} м${c.tricks.length ? ` · распознано: ${TRICK_LABEL[c.tricks[c.tricks.length - 1].name]}` : ''}`,
  done: (_f, c) => c.tricks.some((t) => t.name === name),
});

/** fail when the drone scrapes the ground below `min` m (acro altitude lessons) */
const noGround = (env: LessonEnv, min: number) => (f: LessonFrame) =>
  f.pos.y - env.ground(f.pos.x, f.pos.z) < min && Math.hypot(f.vel.x, f.vel.z) > 1 ? 'Коснулся земли — держи высоту' : null;

// ------------------------------------------------------------------------------------------------ lessons
const cat = (id: string) => {
  const l = LESSONS.find((x) => x.id === id)!;
  return { id, title: l.title, drone: l.drone, map: l.map };
};

const DEFS: LessonDef[] = [
  {
    ...cat('sticks'), spawn: 0, mode: 'normal', lockMode: true, camera: 'chase', showSticks: true,
    brief: 'Камерный дрон с GPS: отпустил стики — висит на месте. Левый стик — газ (вверх/вниз) и рыскание (поворот), правый — тангаж (вперёд/назад) и крен (вбок).',
    build: ({ home }) => {
      const a = V(home.x, home.y + 3, home.z - 15), b = V(home.x + 12, home.y + 3, home.z - 15);
      return {
        steps: [
          arm(true),
          takeoff(3, home, true),
          goPoint('Правый стик вперёд (тангаж) — лети к шару', a, 2.5, b, 'right'),
          goPoint('Правый стик вправо (крен) — сместись к следующему шару', b, 2.5, undefined, 'right'),
          {
            text: 'Левый стик вбок (рыскание) — развернись носом к площадке «H»', stick: 'left',
            targets: [{ kind: 'pad', c: home.clone(), r: 2.5 }],
            sub: (f) => `Осталось ${Math.round((Math.acos(Math.max(-1, Math.min(1, noseTo(f, home)))) * 180) / Math.PI)}°`,
            done: (f) => noseTo(f, home) > 0.96,
          },
          land('Вернись к площадке и сядь: газ вниз', home.clone(), 2.5),
          disarm(true),
        ],
      };
    },
    criteria: [timeC(100, 60), hitsC(1, 0)],
  },
  {
    ...cat('hover'), spawn: 0, mode: 'normal', lockMode: true, camera: 'chase', showSticks: true,
    brief: 'Висение — основа всего. Взлети на 2 м, удержи дрон в круге 10 секунд (ветер слегка сносит), перелети на соседнюю площадку и сядь точно в центр «H».',
    build: ({ home, layout }) => {
      const p1 = layout.spawns[1].pos, pad = V(p1[0], p1[1], p1[2]);
      return {
        steps: [
          arm(true), takeoff(2, home, true),
          hoverIn('Удерживай дрон в круге на высоте 2 м', home.clone(), 1.5, [1.3, 2.8], 10, 2),
          land('Перелети на соседнюю площадку «H» и сядь в центр', pad, 2.2),
          disarm(true),
        ],
      };
    },
    criteria: [timeC(80, 50), landC(1, 0.5), altC(0.6, 0.35)],
  },
  {
    ...cat('orient'), spawn: 0, mode: 'normal', lockMode: true, camera: 'los',
    brief: 'Камера — твои глаза с земли. Пролети «восьмёрку» вокруг двух столбов, затем разверни дрон носом к себе и верни на площадку: когда дрон летит на тебя, крен и рыскание «зеркальные».',
    build: ({ home }) => {
      const P = (x: number, z: number) => V(home.x + x, home.y + 3, home.z + z);
      const route = [P(0, -16), P(-7, -23), P(-14, -16), P(-7, -9), P(0, -16), P(7, -23), P(14, -16), P(7, -9), P(0, -16)];
      const pilot = V(home.x + 3, home.y + 1.6, home.z + 4); // CameraRig.pilot, flight.ts setPilot()
      return {
        props: [{ kind: 'pole', c: V(home.x - 7, home.y, home.z - 16), h: 6 }, { kind: 'pole', c: V(home.x + 7, home.y, home.z - 16), h: 6 }],
        steps: [
          arm(true), takeoff(3, home, true),
          ...route.map((p, i) => goPoint(`Восьмёрка вокруг столбов: точка ${i + 1} из ${route.length}`, p, 2.5, route[i + 1], 'both')),
          {
            text: 'Разверни дрон носом к себе и прилети к площадке', stick: 'both',
            targets: [{ kind: 'pad', c: home.clone(), r: 3 }],
            sub: (f) => `${noseTo(f, pilot) > 0.7 ? 'Нос к тебе ✓' : 'Разверни нос к себе'} · до площадки ${distH(f.pos, home).toFixed(0)} м`,
            done: (f) => distH(f.pos, home) < 3 && noseTo(f, pilot) > 0.7,
          },
          land('Сядь на площадку', home.clone(), 3),
          disarm(true),
        ],
      };
    },
    criteria: [timeC(130, 85), hitsC(1, 0)],
  },
  {
    ...cat('atti'), spawn: 0, mode: 'atti', lockMode: true, camera: 'chase', wind: { mean_ms: 4, dir_deg: 240 },
    brief: 'Режим ATTI: GPS не держит позицию, остаётся только высота по барометру. Ветер 4 м/с сносит дрон — компенсируй правым стиком и удержи его над площадкой 20 секунд.',
    build: ({ home }) => ({
      steps: [
        arm(true), takeoff(4, home, true),
        { ...hoverIn('Держи дрон над площадкой: ветер сносит — компенсируй правым стиком', home.clone(), 2.5, [2.5, 6], 20, 4),
          fail: (f) => (distH(f.pos, home) > 45 ? 'Унесло ветром' : null) },
        land('Сядь на площадку', home.clone(), 3),
        disarm(true),
      ],
    }),
    criteria: [timeC(100, 65), landC(1.5, 0.7), altC(1, 0.5)],
  },
  {
    ...cat('film'), spawn: 0, mode: 'cine', camera: 'fpv',
    brief: 'Кинематографичная орбита: облети столб полный круг на 8–16 м, держа его в кадре. Рецепт — постоянный крен + рыскание в ту же сторону, скорость ровная. Режим Cine — плавные стики.',
    build: ({ home }) => {
      const pole = V(home.x, home.y, home.z - 25);
      const start = V(home.x, home.y + 5, home.z - 13);
      return {
        props: [{ kind: 'pole', c: pole, h: 5 }],
        steps: [
          arm(true), takeoff(5, home, true),
          goPoint('Подлети к точке начала орбиты', start, 3, undefined, 'right'),
          {
            text: 'Облети столб полный круг, держа его в кадре', stick: 'both',
            targets: [{ kind: 'pad', c: pole.clone(), r: 8 }, { kind: 'pad', c: pole.clone(), r: 16 }],
            begin: (f, c) => { c.mem.a = 0; c.mem.b0 = Math.atan2(f.pos.x - pole.x, f.pos.z - pole.z); c.mem.n = c.mem.v = c.mem.v2 = c.mem.r = c.mem.r2 = c.mem.fr = 0; },
            sub: (f, c) => {
              const r = distH(f.pos, pole), alt = c.alt(f);
              const band = r < 8 ? 'Дальше от столба' : r > 16 ? 'Ближе к столбу' : alt < 3 ? 'Выше' : alt > 12 ? 'Ниже' : '';
              return `${band ? band + ' · ' : ''}пройдено ${Math.abs((c.mem.a * 180) / Math.PI).toFixed(0)}° · в кадре ${c.mem.n ? Math.round((c.mem.fr / c.mem.n) * 100) : 0} %`;
            },
            done: (f, c) => {
              const r = distH(f.pos, pole), alt = c.alt(f);
              const b = Math.atan2(f.pos.x - pole.x, f.pos.z - pole.z);
              if (r >= 8 && r <= 16 && alt >= 3 && alt <= 12) {
                c.mem.a += angDiff(b, c.mem.b0);
                const v = Math.hypot(f.vel.x, f.vel.z);
                c.mem.n++; c.mem.v += v; c.mem.v2 += v * v; c.mem.r += r; c.mem.r2 += r * r;
                if (noseTo(f, pole) > 0.9) c.mem.fr++;
              }
              c.mem.b0 = b;
              if (Math.abs(c.mem.a) < 2 * Math.PI) return false;
              const n = c.mem.n, mv = c.mem.v / n, mr = c.mem.r / n;
              c.m.x.cv = Math.sqrt(Math.max(0, c.mem.v2 / n - mv * mv)) / Math.max(0.1, mv);
              c.m.x.rstd = Math.sqrt(Math.max(0, c.mem.r2 / n - mr * mr));
              c.m.x.frame = c.mem.fr / n;
              return true;
            },
          },
        ],
      };
    },
    criteria: [
      { label: 'Объект в кадре', get: (m) => (m.x.frame ?? 0) * 100, fmt: (v) => `${v.toFixed(0)} %`, two: 60, three: 85, higher: true },
      { label: 'Разброс скорости', get: (m) => (m.x.cv ?? 1) * 100, fmt: (v) => `${v.toFixed(0)} %`, two: 30, three: 15 },
      { label: 'Разброс радиуса', get: (m) => m.x.rstd ?? 99, fmt: (v) => `${v.toFixed(1)} м`, two: 2.5, three: 1.2 },
    ],
  },
  {
    ...cat('angle'), spawn: { x: -30, z: 56, yaw: 0 }, mode: 'angle', lockMode: true, camera: 'fpv',
    brief: 'Первый FPV: синевуп в режиме Angle — стики задают наклон, отпустил — выровнялся. Газ не держит высоту: его ведёшь сам. Пролети шесть ворот трассы по порядку.',
    build: ({ layout }) => {
      const gates = layout.gates.slice(0, 6).map((g) => ({ c: V(...g.c), q: quatT(g.q), w: g.w, h: g.h }));
      return {
        steps: [
          arm(false),
          ...gates.map((g, i) => gateStep(`Ворота ${i + 1} из ${gates.length}`, g, gates[i + 1] && { kind: 'gate', ...gates[i + 1] })),
        ],
      };
    },
    criteria: [timeC(60, 35), hitsC(2, 0)],
  },
  {
    ...cat('acro_thr'), spawn: 0, mode: 'acro', lockMode: true, camera: 'fpv',
    brief: 'Acro: дрон держит угол, который ты задал, — сам не выравнивается и высоту не держит. Облети кольцо из 8 точек на высоте ~4 м: газ подбирай под наклон, к земле не прижимайся.',
    build: (env) => {
      const { home } = env, R = 35, n = 8;
      const a0 = Math.atan2(home.x, home.z); // start with the ring point nearest the pad
      const ring = Array.from({ length: n }, (_, i) => {
        const a = a0 + (i / n) * 2 * Math.PI, x = Math.sin(a) * R, z = Math.cos(a) * R;
        return V(x, env.ground(x, z) + 4, z);
      });
      const fail = noGround(env, 0.6);
      return {
        steps: [
          arm(false), takeoff(4, home, false),
          ...ring.map((p, i) => ({ ...goPoint(`Кольцо: точка ${i + 1} из ${n}`, p, 3.5, ring[i + 1], 'both'), trackAlt: 4, fail })),
          land('Вернись и сядь на площадку', home.clone(), 4),
          disarm(false),
        ],
      };
    },
    criteria: [altC(1.5, 0.8), timeC(80, 50), hitsC(1, 0)],
  },
  {
    ...cat('acro_turn'), spawn: { x: -67, z: 8.5, yaw: -90 }, mode: 'acro', lockMode: true, camera: 'fpv',
    brief: 'Координированный поворот: крен и рыскание вместе, нос ведёт по дуге, газ компенсирует наклон. Пройди слалом между флагами, развернись — и сделай split-S: полубочка и полупетля вниз.',
    build: (env) => {
      const flags = Array.from({ length: 8 }, (_, k) => ({ x: -60 + k * 6, z: 10 - 3 * (k % 2) }));
      const slalom = flags.map((f, k) => V(f.x, env.ground(f.x, f.z) + 2.2, f.z + (k % 2 ? 3.6 : -3.6)));
      const turn = V(-6, env.ground(-6, 20) + 4, 20), back = V(-40, env.ground(-40, 28) + 6, 28);
      return {
        steps: [
          arm(false),
          ...slalom.map((p, i) => goPoint(`Слалом: флаг ${i + 1} из 8`, p, 2.3, slalom[i + 1] ?? turn, 'both')),
          goPoint('Координированный разворот на 180° к шару', turn, 4, back, 'both'),
          goPoint('Обратно — плавная дуга к шару', back, 4, undefined, 'both'),
          { text: 'Набери 15 м — запас для split-S', stick: 'left', sub: (f, c) => `Высота ${c.alt(f).toFixed(0)} / 15 м`, done: (f, c) => c.alt(f) >= 14 },
          trickStep('split_s', 'Split-S: полубочка (крен 180°), затем тангаж на себя — полупетля вниз'),
        ],
      };
    },
    criteria: [timeC(90, 55), hitsC(1, 0)],
  },
  {
    ...cat('tricks'), spawn: 0, mode: 'acro', lockMode: true, camera: 'fpv',
    brief: 'Трюки распознаются по траектории и ориентации. Запас высоты — 15 м. Flip: тангаж до упора на месте; roll: крен до упора; power loop: разгон и полная петля «на себя» с набором высоты; split-S.',
    build: ({ home }) => ({
      steps: [
        arm(false),
        { text: 'Набери 15 м', stick: 'left', targets: [{ kind: 'pad', c: home.clone(), r: 2 }], sub: (f, c) => `Высота ${c.alt(f).toFixed(0)} / 15 м`, done: (f, c) => c.alt(f) >= 14 },
        trickStep('flip', 'Flip: полный оборот по тангажу (газ — сброс в верхней точке, подхват внизу)'),
        trickStep('roll', 'Roll: полный оборот по крену'),
        trickStep('power_loop', 'Power loop: разгонись > 20 км/ч и потяни тангаж на себя — петля вверх'),
        trickStep('split_s', 'Split-S: полубочка и полупетля вниз — разворот назад'),
      ],
    }),
    criteria: [timeC(120, 60), hitsC(1, 0)],
  },
  {
    ...cat('bando'), spawn: 0, camera: 'fpv',
    brief: 'Бандо — полёты внутри зданий. Влети в паркинг через проём, пролети этаж, поднимись по шахте пандуса на третий уровень, вылети через западный проём и сядь на крышу. В тесноте пропвош трясёт дрон — не роняй газ резко.',
    build: () => {
      const enter = { c: V(0, 2.07, 24), q: gateQuat(0, -1), w: 5, h: 1.6 };
      const exit = { c: V(-36, 8.85, -4), q: gateQuat(-1, 0), w: 5, h: 1.4 };
      const route = [V(16, 1.8, 4), V(24, 1.8, 4), V(24, 8.4, 4), V(-4, 8.4, -4)];
      const roofUp = V(-41, 19.5, -4), roof = V(0, 17.2, 0);
      return {
        steps: [
          arm(false),
          gateStep('Влети в паркинг через проём', enter, { kind: 'point', c: route[0], r: 1.2 }),
          goPoint('Пролети этаж к пандусу', route[0], 2, route[1], 'both'),
          goPoint('Под шахтой: зависни под проёмом', route[1], 1.8, route[2], 'both'),
          goPoint('Вверх по шахте на третий уровень (два перекрытия)', route[2], 1.8, route[3], 'left'),
          goPoint('Пролети уровень на запад', route[3], 2, undefined, 'both'),
          gateStep('Вылети через проём в западной стене', exit, { kind: 'point', c: roofUp, r: 2 }),
          goPoint('Поднимись выше парапета крыши', roofUp, 3, undefined, 'left'),
          land('Сядь на крышу', roof, 4),
          disarm(false),
        ],
      };
    },
    criteria: [timeC(90, 50), hitsC(3, 1)],
  },
  {
    ...cat('long_range'), spawn: 3, mode: 'angle', camera: 'fpv',
    brief: 'Дальний полёт: три маяка по краю поля и возврат на ВПП, ~900 м. Следи за напряжением на банку и током: на полном газу Li-ion садится быстро — оптимальна крейсерская скорость.',
    build: (env) => {
      const B = (x: number, z: number) => V(x, env.home.y + 50, z);
      const route = [B(0, -200), B(-190, -60), B(-130, 160)];
      return {
        steps: [
          arm(false),
          ...route.map((p, i) => goPoint(`Маяк ${i + 1} из ${route.length}`, p, 12, route[i + 1], 'both')),
          land('Вернись и сядь на ВПП', env.home.clone(), 8),
          disarm(false),
        ],
      };
    },
    criteria: [
      { label: 'Остаток батареи', get: (m) => m.soc * 100, fmt: (v) => `${v.toFixed(0)} %`, two: 45, three: 60, higher: true },
      timeC(200, 120), hitsC(1, 0),
    ],
  },
  {
    ...cat('wing'), spawn: 0, camera: 'chase',
    brief: 'VTOL: взлёт как мультикоптер, переход в самолёт (подъёмные моторы гаснут на 15 м/с), полёт к маяку, разворот домой, обратный переход и вертикальная посадка. Режимы: 1 — MC, 2 — переход, 3 — FW.',
    build: ({ home }) => {
      const beacon = V(home.x - 100, home.y + 30, home.z - 220), over = V(home.x, home.y + 30, home.z);
      return {
        steps: [
          arm(true), takeoff(25, home, true),
          { text: 'Переход в самолёт: режим «Переход» (2) или FW (3)', sub: (f) => (f.vtolPhase === 'trans_fw' ? 'Переход: разгон…' : ''), done: (f) => f.vtolPhase === 'fw' },
          goPoint('Лети к маяку (крен — поворот, газ — скорость)', beacon, 25, over, 'right'),
          goPoint('Разворот — домой', over, 35, undefined, 'right'),
          { text: 'Обратный переход: режим MC (1)', sub: (f) => (f.vtolPhase === 'trans_mc' ? 'Торможение…' : ''), done: (f) => f.vtolPhase === 'mc' },
          land('Вертикальная посадка на площадку', home.clone(), 10),
          disarm(true),
        ],
      };
    },
    criteria: [timeC(240, 150), landC(5, 2)],
  },
];

export const LESSON_DEFS: Record<string, LessonDef> = Object.fromEntries(DEFS.map((d) => [d.id, d]));
export const lessonDef = (id: string): LessonDef | undefined => LESSON_DEFS[id];

/** lesson i is open when it is the first or the previous one has at least one star */
export function lessonUnlocked(id: string, stars: (id: string) => number): boolean {
  const i = LESSONS.findIndex((l) => l.id === id);
  return i <= 0 || stars(LESSONS[i - 1].id) > 0;
}
export const nextLesson = (id: string) => LESSONS[LESSONS.findIndex((l) => l.id === id) + 1]?.id;

