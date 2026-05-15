// Dev API route modules import themselves here. Each module's import
// triggers a side-effecting registerDevApiHandler() call at module load.
import './acpRoutes.js';
import './agentCardRoutes.js';
import './aggregatorRoutes.js';
import './ap2Routes.js';
import './bridgeRoutes.js';
import './signalsRoutes.js';
import './skillsRoutes.js';

export {};
