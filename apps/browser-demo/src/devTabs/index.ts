// Phase 1 dev-tab modules import themselves here. Each module's import
// triggers a side-effecting registerDevTab() call at module load.
//
// Append-only — Phase 1 agents add lines like:
//   import './payOut.js';
//   import './externalAgents.js';
//   import './agentCard.js';
// And badge modules:
//   import '../devBadges/ap2Verified.js';
import './payOut.js';
import './externalAgents.js';
import './agentCard.js';
import './skills.js';
import '../devBadges/ap2Verified.js';
import '../devBadges/acpOutbound.js';
export {};
