import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'apps/browser-demo/dist');
const indexHtml = join(dist, 'index.html');

const routes = [
  'docs',
  'app',
  'cli',
  'desktop',
  'android',
  'demo',
  'mwa-test',
  'privacy',
  'terms',
];

await stat(indexHtml);

await copyFile(indexHtml, join(dist, '404.html'));

await Promise.all(
  routes.map(async (route) => {
    const routeDir = join(dist, route);
    await mkdir(routeDir, { recursive: true });
    await copyFile(indexHtml, join(routeDir, 'index.html'));
  }),
);

console.log(`[render] Wrote SPA route fallbacks for ${routes.length} route(s).`);
