// Costruisce la web app per Android: stessa interfaccia (public/) e stesso motore (src/engine),
// con archivio, rete e backend sostituiti dalle versioni mobile.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'mobile/www');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const swap = {
  [path.join(root, 'public/backend.js')]: path.join(root, 'mobile/backend.js'),
  [path.join(root, 'src/db.js')]: path.join(root, 'mobile/store.js'),
  [path.join(root, 'src/fetcher.js')]: path.join(root, 'mobile/fetcher.js'),
};
const mobileSwap = {
  name: 'mobile-swap',
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      const target = path.resolve(args.resolveDir, args.path);
      return swap[target] ? { path: swap[target] } : undefined;
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(root, 'public/app.js')],
  bundle: true, format: 'esm', platform: 'browser', target: ['chrome100'],
  outfile: path.join(out, 'app.js'), minify: true, sourcemap: false, plugins: [mobileSwap],
  logLevel: 'info',
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || 'dev') },
});
fs.copyFileSync(path.join(root, 'public/style.css'), path.join(out, 'style.css'));
fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), path.join(out, 'pdf.worker.min.mjs'));
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
  .replace('href="/style.css"', 'href="style.css"').replace('src="/app.js"', 'src="app.js"');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('www pronta in', out);
