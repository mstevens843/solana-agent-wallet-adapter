import { VSR_PROGRAM_ID } from './constants.js';

export interface PluginDetectionInput {
  communityVoterWeightAddinProgramId?: string | null;
  communityMaxVoteWeightAddinProgramId?: string | null;
  councilVoterWeightAddinProgramId?: string | null;
  councilMaxVoteWeightAddinProgramId?: string | null;
}

export interface PluginDetectionResult {
  pluginsDetected: boolean;
  pluginNames: string[];
}

const KNOWN_PLUGINS: Record<string, string> = {
  [VSR_PROGRAM_ID.toBase58()]: 'voter-stake-registry',
};

export function detectPlugins(input: PluginDetectionInput): PluginDetectionResult {
  const ids = [
    input.communityVoterWeightAddinProgramId,
    input.communityMaxVoteWeightAddinProgramId,
    input.councilVoterWeightAddinProgramId,
    input.councilMaxVoteWeightAddinProgramId,
  ].filter((value): value is string => Boolean(value && value.trim()));

  if (ids.length === 0) {
    return { pluginsDetected: false, pluginNames: [] };
  }

  const names = Array.from(
    new Set(ids.map((id) => KNOWN_PLUGINS[id] ?? `unknown_plugin:${id}`)),
  );
  return { pluginsDetected: true, pluginNames: names };
}

// V1 stance: when any plugin is present, the raw token-owner-record balance is
// not authoritative for voting power. Cast vote is hard-refused; deposit and
// withdraw target the raw TOR balance directly and remain allowed with a warning.
export function mayCastVoteWithRawTor(plugins: PluginDetectionResult): boolean {
  return !plugins.pluginsDetected;
}
