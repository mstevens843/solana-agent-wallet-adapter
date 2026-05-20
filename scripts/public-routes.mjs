export const publicAppRoutes = [
  '/',
  '/docs',
  '/builders',
  '/app',
  '/cli',
  '/desktop',
  '/android',
  '/demo',
  '/mwa-test',
  '/privacy',
  '/terms',
  '/delete-account',
];

export const publicAppRouteDirs = publicAppRoutes
  .filter((route) => route !== '/')
  .map((route) => route.slice(1));
