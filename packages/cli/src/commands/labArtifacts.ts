/**
 * Lab artifacts management — read/save/delete the signed research artifacts
 * stored by the local bridge.
 *
 *   GET  /bridge/lab-artifacts
 *   POST /bridge/lab-artifacts          {artifact: {...}}
 *   POST /bridge/lab-artifacts/delete   {artifactId}
 *
 * Used via `research artifacts <op>` to extend the existing `/research`
 * surface without claiming a new top-level group.
 */
import type { ParsedArgs } from '../shared/types.js';
import { readJsonFile } from '../shared/util.js';
import { bridgeRequest } from '../http/index.js';

export async function dispatchLabArtifacts(parsed: ParsedArgs): Promise<unknown> {
  // Expected positionals: ['research', 'artifacts', op, ...]
  const op = parsed.positionals[2] ?? 'list';
  if (op === 'list') {
    return bridgeRequest(parsed.options, '/bridge/lab-artifacts');
  }
  if (op === 'save') {
    const file = parsed.positionals[3];
    if (!file) throw new Error('Usage: solana-agent-wallet research artifacts save <artifact.json>');
    const artifact = await readJsonFile(file, 'artifact');
    return bridgeRequest(parsed.options, '/bridge/lab-artifacts', {
      method: 'POST',
      body: JSON.stringify({ artifact }),
    });
  }
  if (op === 'delete') {
    const id = parsed.positionals[3];
    if (!id) throw new Error('Usage: solana-agent-wallet research artifacts delete <artifact-id>');
    return bridgeRequest(parsed.options, '/bridge/lab-artifacts/delete', {
      method: 'POST',
      body: JSON.stringify({ artifactId: id }),
    });
  }
  throw new Error(`Unknown research artifacts subcommand: ${op}. Try: list | save | delete`);
}
