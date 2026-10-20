import { defineConfig, type Plugin, type UserConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '../assets');
const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.hdr': 'application/octet-stream', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.ktx2': 'image/ktx2', '.webp': 'image/webp',
};

/** Serves the shared ../assets folder at /assets in dev; copies what the shipped maps need on build.
 *  @param mobile ship only the 1k texture set (tools/make_lowres.py) — the APK stays small and fits phone GPUs */
function sharedAssets(buildMaps: string[], mobile: boolean): Plugin {
  let outDir = 'dist';
  return {
    name: 'dronesim-assets',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const file = path.join(ASSETS, rel);
        if (!file.startsWith(ASSETS)) return next();
        fs.stat(file, (err, st) => {
          if (err || !st.isFile()) return next();
          res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
          res.setHeader('Content-Length', st.size);
          fs.createReadStream(file).pipe(res);
        });
      });
    },
    closeBundle() {
      const skip = mobile ? /_(2k|4k|8k)\.(jpg|png)$|_disp_/ : /_disp_/;
      const copy = (rel: string) => {
        const src = path.join(ASSETS, rel), dst = path.join(outDir, 'assets', rel);
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, { recursive: true, filter: (f) => !skip.test(path.basename(f)) });
      };
      copy('presets'); copy('manifest.json'); copy('ui');
      for (const f of fs.readdirSync(path.join(ASSETS, 'models/drones'))) if (f.endsWith('.glb')) copy('models/drones/' + f);
      for (const id of buildMaps) {
        const L = JSON.parse(fs.readFileSync(path.join(ASSETS, `maps/${id}/${id}.json`), 'utf-8'));
        copy(`maps/${id}/${id}.json`); copy(`maps/${id}/${id}.glb`); copy('hdri/' + L.env.hdri);
        for (const m of Object.values<{ tex: string | null }>(L.materials)) if (m.tex) copy('textures/' + m.tex);
        for (const p of new Set<string>(L.props.map((x: { asset: string }) => x.asset))) copy('props/' + p);
      }
    },
  };
}

/** облегчённый набор ассетов (assets-lite из Releases) — только 1k-текстуры: тогда 2k не запрашиваем (иначе всё чёрное) */
function hasOnly1kTextures(): boolean {
  const dir = path.join(ASSETS, 'textures');
  if (!fs.existsSync(dir)) return false;
  for (const d of fs.readdirSync(dir)) {
    const sub = path.join(dir, d);
    if (fs.statSync(sub).isDirectory() && fs.readdirSync(sub).some((f) => f.endsWith('_2k.jpg'))) return false;
  }
  return true;
}

/** maps in the builds: the PC build carries all of them, the phone build only the light ones (heavy props) */
export const SHIPPED_MAPS = ['training_field', 'parking_garage', 'abandoned_factory', 'ruined_district'];
export const MOBILE_MAPS = ['training_field', 'parking_garage'];

export default defineConfig(({ mode }) => ({ // vitest's `test` key is not in vite's UserConfig type
  base: './',
  define: {
    __LITE_ASSETS__: JSON.stringify(mode !== 'mobile' && hasOnly1kTextures()),
    __SHIPPED_MAPS__: JSON.stringify(mode === 'mobile' ? MOBILE_MAPS : SHIPPED_MAPS),
  },
  plugins: [sharedAssets(mode === 'mobile' ? MOBILE_MAPS : SHIPPED_MAPS, mode === 'mobile')],
  server: { port: 5173, host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } }, // UI in Preact (src/ui/app)
  worker: { format: 'es' }, // the physics worker (core/sim.worker.ts) is an ES module
  test: { environment: 'node', testTimeout: 60000 },
}) as UserConfig);
