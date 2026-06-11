export const publicAppRoutes = [
  '/',
  '/docs',
  '/builders',
  '/app',
  '/qr-connect',
  '/cli',
  '/desktop',
  '/aiconnectors',
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
