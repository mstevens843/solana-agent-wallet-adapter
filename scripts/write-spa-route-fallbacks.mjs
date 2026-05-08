import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { publicAppRouteDirs } from './public-routes.mjs';

const root = process.cwd();
const dist = join(root, 'apps/browser-demo/dist');
const indexHtml = join(dist, 'index.html');

await stat(indexHtml);

await copyFile(indexHtml, join(dist, '404.html'));

await Promise.all(
  publicAppRouteDirs.map(async (route) => {
    const routeDir = join(dist, route);
    await mkdir(routeDir, { recursive: true });
    await copyFile(indexHtml, join(routeDir, 'index.html'));
  }),
);

console.log(`[render] Wrote SPA route fallbacks for ${publicAppRouteDirs.length} route(s).`);
