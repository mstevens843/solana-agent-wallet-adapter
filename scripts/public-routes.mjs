export const publicAppRoutes = [
  '/',
  '/docs',
  '/app',
  '/cli',
  '/desktop',
  '/android',
  '/demo',
  '/mwa-test',
  '/privacy',
  '/terms',
];

export const publicAppRouteDirs = publicAppRoutes
  .filter((route) => route !== '/')
  .map((route) => route.slice(1));
