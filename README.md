# DroneSim

Реалистичный симулятор управления дронами для обучения и практики — FPV (5"/7"/10", синевуп), камерные GPS-дроны (класс Mavic, Bebop, Typhoon), платформы PX4/ArduPilot, VTOL и самолётного типа. ПК + Android/iOS, управление с клавиатуры, тача, геймпада и настоящего RC-пульта.

**Статус: Этап 1 готов** — можно летать на FPV 5" по «Полигону» (Acro/Angle/Horizon, ворота с таймером, краш/рестарт). Следующий шаг — Этап 2 «физика как в жизни» из [`docs/PLAN.md`](docs/PLAN.md).

## Быстрый старт (без сборки)
Скачай из [Releases](../../releases) `DroneSim-debug.apk` (Android) или `DroneSim-web.zip` (веб-версия: распаковать и открыть через любой статический сервер, например `npx serve .`; двойной клик по `index.html` не сработает).

## Запуск из исходников
Папка `assets/` (3.8 ГБ) в репозиторий **не входит**. Для запуска возьми облегчённый набор:
1. Скачай из [Releases](../../releases) `DroneSim-assets-lite.zip` и распакуй в корень репозитория, чтобы получилось `assets/maps`, `assets/models`, `assets/presets` и т.д. (1k-текстуры, хватает для игры; полный набор пересобирается скриптами из `tools/`, см. [`docs/ASSETS.md`](docs/ASSETS.md)).
2. Запусти:
```bash
cd app
npm install
npm run dev
```
(из корня тоже работает: `npm install --prefix app` и `npm run dev`).

Открыть http://localhost:5173. Если вместо меню «Не удалось запустить симулятор» — не найдены ассеты (см. шаг 1). Управление: `W/S` газ, `A/D` рыскание, стрелки — тангаж/крен, `Пробел` арм, `1/2/3` режимы, `C` камера, `R` рестарт, `M` мышь как стик. Геймпад и RC-пульт (USB Joystick) подхватываются автоматически.

## Документы
| Файл | О чём |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | мастер-план: стек, архитектура, управление, режимы, UI, звук, графика, **этапы с чек-листами** |
| [`docs/research/PHYSICS.md`](docs/research/PHYSICS.md) | физическая модель: моторы, батарея, пропеллеры, пропвош, ветер, полётные контроллеры, тесты |
| [`docs/research/DRONES.md`](docs/research/DRONES.md) | каталог 12 дронов: как каждый летает и управляется |
| [`docs/ASSETS.md`](docs/ASSETS.md) | ассеты, источники, лицензии, пересборка |
| [`docs/design/DESIGN.md`](docs/design/DESIGN.md) | дизайн-система; [`ui_mockup.html`](docs/design/ui_mockup.html) — интерактивный макет |
| [`CLAUDE.md`](CLAUDE.md) | правила для ИИ-сессий |

## Превью
![Дроны (свои)](docs/previews/_sheet_custom.jpg)
![Дроны (Gazebo)](docs/previews/_sheet_fuel.jpg)
![Карты](docs/previews/_sheet_maps.jpg)

## Структура
```
assets/   models/drones (GLB) · maps (GLB+JSON) · textures (PBR 2K) · hdri · props · audio · presets/drones.json · manifest.json
docs/     PLAN, research, design, previews
tools/    fetch_* (Poly Haven, Freesound, Sketchfab), build_manifest, prune_audio, blender/ (drone_builder, map_builder, sdf_to_glb, render_*), портативный Blender 4.5
app/      игра: src/sim (физика 1 кГц, Betaflight FC), render, input, camera, game, ui; test/ (vitest)
```
