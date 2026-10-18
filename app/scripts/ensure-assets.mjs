// Перед `npm run dev`: если нет папки ../assets с картами/моделями — качает DroneSim-assets-lite.zip из GitHub Releases.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL = 'https://github.com/cubestalkertube-creator/DroneSim/releases/download/v0.4-debug/DroneSim-assets-lite.zip';

if (fs.existsSync(path.join(ROOT, 'assets/maps')) && fs.existsSync(path.join(ROOT, 'assets/models'))) process.exit(0);

console.log('[assets] папка assets/ не найдена — скачиваю облегчённый набор (~58 МБ)…');
try {
  const r = await fetch(URL);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
  let n = 0;
  for (const [raw, data] of Object.entries(files)) {
    const name = raw.replaceAll('\\', '/'); // Compress-Archive (PS 5.1) пишет обратные слэши
    if (name.endsWith('/')) continue;
    const dst = path.resolve(ROOT, name);
    if (!dst.startsWith(ROOT + path.sep)) continue; // защита от ../ в архиве
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
    n++;
  }
  console.log(`[assets] готово: ${n} файлов → assets/`);
} catch (e) {
  console.error(`[assets] не удалось скачать (${e.message}). Скачай вручную: ${URL} и распакуй в корень репозитория.`);
  process.exit(1);
}
