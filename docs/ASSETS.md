# Ассеты DroneSim — что есть, откуда, лицензии

Индекс для игры: [`assets/manifest.json`](../assets/manifest.json) (пересобрать: `python -I tools/build_manifest.py`).

| Папка | Что | Объём | Источник / лицензия |
|---|---|---|---|
| `assets/models/drones/` | 12 дронов GLB (реальный масштаб, +Y вперёд в Blender) | 27 МБ | см. таблицу ниже |
| `assets/models/drones/source/drones_custom.blend` | исходник своих дронов | — | собственные (генератор `tools/blender/drone_builder.py`) |
| `assets/models/drones/textures/` | карбон 3K, диск размытия пропа (сгенерированы) | — | собственные |
| `assets/presets/drones.json` | физика/управление всех дронов | — | собственные (часть констант — из PX4/Gazebo SDF) |
| `assets/maps/<id>/` | 4 карты: `.glb` + `.json` | ~17 МБ | собственные (генератор `tools/blender/map_builder.py`) |
| `assets/maps/source/maps_all.blend` | все карты для правки в Blender (сцены `MAP_*`, пропсы как инстансы) | ~200 МБ | собственные |
| `assets/textures/` | 53 PBR-набора 2K (diff / nor_gl / arm[AO,rough,metal]) + 1K-копии для мобилок (`tools/make_lowres.py`; там же собирается `arm` из `rough`, если его нет) | 560 МБ + ~150 МБ | Poly Haven **CC0**; `acg_*` — ambientCG **CC0** |
| `assets/hdri/` | 32 HDRI (.hdr 2K, 3 шт. 4K) + `thumbs/` | 228 МБ | Poly Haven **CC0** |
| `assets/props/` | 62 пропса glTF 2K (бочки, барьеры, трубы, фасады, фонари, машины, деревья…) | 2.1 ГБ | Poly Haven **CC0** |
| `assets/audio/` | 239 отобранных звуков в 11 категориях (MP3 HQ-превью) + 176 сомнительных в `_rejected/` + `CREDITS.json` | 245 МБ | Freesound **CC0 / CC-BY** (CC-BY → в титры) |
| `assets/_raw/fuel/` | исходники моделей Gazebo (SDF, DAE/STL) | 134 МБ | Gazebo Fuel (лицензии ниже) |
| `assets/_sketchfab/` | (пусто) — сюда скачает `tools/fetch_sketchfab.py` | — | Sketchfab CC-BY и др. |
| `tools/blender-4.5.14-windows-x64/` | портативный Blender 4.5 LTS для сборки ассетов | 0.9 ГБ | blender.org (GPL) |

## Дроны
| id | Модель | Источник | Лицензия | Треуг. |
|---|---|---|---|---|
| `fpv_5in_freestyle` | 5" фристайл (GoPro, O3, 6S) | своя, `drone_builder.py` | собственная | ~9k |
| `fpv_5in_racer` | 5" гоночный | своя | собственная | ~8k |
| `fpv_7in_longrange` | 7" long range + GPS | своя | собственная | ~8k |
| `fpv_10in_heavy` | 10" грузовой + бокс | своя | собственная | ~9k |
| `cinewhoop_3in` | синевуп 3" в кольцах | своя | собственная | ~13k |
| `camera_drone_fold` | складной камерный (класс Mavic, без бренда) | своя | собственная | ~5k |
| `delta_wing_lm` | дельта-крыло класса Shahed-136 (планер) | своя | собственная | ~2k |
| `x500` | Holybro X500 V2 | Gazebo Fuel `PX4/x500` | CC-BY 4.0 (автор Benjamin Perseghetti, Rudis Labs) | ~47k |
| `typhoon_h480` | Yuneec Typhoon H480 | Gazebo Fuel `Gambit/Typhoon H480` | CC-BY 4.0 | ~155k (нужен LOD) |
| `parrot_bebop_2` | Parrot Bebop 2 | Gazebo Fuel `OpenRobotics/Parrot Bebop 2` | CC0 | ~33k |
| `iris_with_standoffs` | 3DR Iris+ | Gazebo Fuel `OpenRobotics/Iris with Standoffs` | CC0 | ~45k |
| `standard_vtol` | Skywalker X8 VTOL | Gazebo Fuel `PX4/Standard VTOL` | CC-BY 4.0 | ~35k |

Превью: `docs/previews/*.png` (студийные) и `docs/previews/ui/*.png` (прозрачный фон для UI). Для меню игры они ужаты в `assets/ui/maps/<id>.jpg` (1280 px) и `assets/ui/drones/<id>.webp` (640 px, прозрачные) — `python -I tools/make_ui_previews.py` (сборка копирует `assets/ui` целиком).
Пересборка: `blender -b --factory-startup -P tools/blender/sdf_to_glb.py -- assets/_raw/fuel/<Model> assets/models/drones/<id>.glb` и `-P <scratch>.py` с `exec(drone_builder.py); build_all()`.

## Карты
| id | Название | Треуг. | Коллайдеров | Спавны / ворота | HDRI |
|---|---|---|---|---|---|
| `training_field` | Полигон | 18k | 544 + heightfield | 5 / 10 | kloofendal_48d_partly_cloudy_puresky_4k |
| `abandoned_factory` | Заброшенный завод | 10k | 774 + heightfield | 3 / 0 (+3 трик-линии) | industrial_sunset_puresky_4k |
| `ruined_district` | Разрушенный квартал | 84k | 13 169 (нужно слияние в крупные OBB) | 2 / 0 | overcast_soil_puresky_2k |
| `parking_garage` | Паркинг | 8k | 827 + heightfield | 2 / 0 | kloofendal_overcast_puresky_2k |

Превью: `docs/previews/map_*.png`. Генерация + рендер: `blender -b --factory-startup -P tools/blender/render_maps.py -- [ids]`. Фоны меню карт (`assets/ui/maps/<id>.jpg`) с октября 2026 — кадры из самой игры вместе с окрестностями (`docs/previews/ingame/map_<id>.jpg`, 1280 px): камера ставится через `__ds.rig` в dev-сборке, HUD скрыт.

Окрестности карт (холмы, горы, лес / город / промзона за краем карты) не лежат в ассетах — они генерируются кодом из фиксированного seed: форма — `app/src/sim/outer.ts` (её же коллайдит физика), вид — `app/src/render/surroundings.ts` (таблица `LOOK` по id карты: текстура земли, оттенки, плотность леса, туман).

## Звуки (категории `assets/audio/`)
`motors_fpv`, `motors_camera_drone`, `motors_heavy_multirotor`, `engines_fixed_wing`, `props_aero`, `wind`, `impacts`, `electronics` (бипы ESC, батарея, сервы), `fpv_video_static`, `ambience`, `ui`. Нерелевантные результаты поиска перенесены в `_rejected/` (`tools/prune_audio.py`) — прослушать и удалить. Каждый файл есть в `CREDITS.json` (автор, лицензия, URL) — **CC-BY обязательно указать в титрах игры**. Для релиза: заменить HQ-превью на оригиналы WAV/FLAC (нужен API-ключ Freesound) — названия/ID те же.

## Sketchfab (по желанию пользователя)
`tools/fetch_sketchfab.py` содержит курируемый список из ~45 моделей (DJI FPV, Avata 2, Inspire 3, TB2, ZALA, Orion, пульты RadioMaster, FPV-очки, гоночные ворота, заброшенные склады/заводы, паркинги, панельки, вышки). Нужен **бесплатный API-токен** пользователя:
```
$env:SKETCHFAB_TOKEN="<токен из sketchfab.com → Settings → Password & API>"
python -I tools/fetch_sketchfab.py            # только CC-BY и совместимые
python -I tools/fetch_sketchfab.py --all      # + некоммерческие (NC/ND) — только для личного прототипа
```
После скачивания — оптимизация (Этап 4): `gltf-transform simplify/meshopt/ktx2`, единицы → метры, ориентация → +Y вперёд.

## Правила лицензий
* CC0 — можно всё, атрибуция не требуется (но вежливо указываем Poly Haven/ambientCG в титрах).
* CC-BY 4.0 — обязательна атрибуция (автор, название, ссылка, лицензия) — генерируется из `CREDITS.json`.
* NC / ND (некоторые модели Sketchfab) — не включать в публичные/коммерческие сборки.
