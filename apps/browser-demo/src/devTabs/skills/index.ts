// Phase 1 Layer 2 sub-tab modules import themselves here. Each module's import
// triggers a side-effecting registerSkillsSubTab() call at load.
//
// Append-only — Phase 1 agents add lines like:
//   import './browse.js';
//   import './installed.js';
//   import './myProfile.js';
//   import './publish.js';
import './browse.js';
import './installed.js';
import './myProfile.js';
import './publish.js';
export {};
