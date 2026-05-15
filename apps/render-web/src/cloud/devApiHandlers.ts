// Phase 1 dev-API route modules import themselves here. Each module's import
// triggers a side-effecting registerDevApiHandler() call at module load.
//
// Append-only — Phase 1 agents add lines like:
//   import './ap2Routes.js';
//   import './acpRoutes.js';
//   import './agentCardRoutes.js';
//   import './bridgeRoutes.js';
import './acpRoutes.js';
import './agentCardRoutes.js';
import './ap2Routes.js';
import './bridgeRoutes.js';

export {};
