import { input, select, header, badge, multilineInput, kv, divider } from '../tui/index.js';
import type { ProofSpec, ProofField } from './proofSpecs.js';

export interface ProofDraft {
  specId: string;
  // For Common proofs (which have a fields[] catalog), this holds the per-field
  // values keyed by field id. For Advanced proofs, fields is empty and `input`
  // holds the single freeform message instead.
  fields: Record<string, string>;
  input: string;
}

export async function promptProofForm(spec: ProofSpec): Promise<ProofDraft> {
  console.log();
  console.log(header(spec.title));
  console.log(kv([
    ['What this proves', spec.whatThisProves],
    ['Best use',         spec.recommendedUse],
    ['Tier',             spec.category === 'common' ? badge('Common', 'ok') : badge('Advanced', 'warn')],
  ]));
  console.log(divider());

  const draft: ProofDraft = { specId: spec.id, fields: {}, input: '' };

  if (spec.fields && spec.fields.length > 0) {
    for (const field of spec.fields) {
      const value = await promptField(field);
      if (value !== undefined) draft.fields[field.id] = value;
    }
    draft.input = serializeFields(spec, draft.fields);
    return draft;
  }

  // Advanced — single free-text input.
  draft.input = await multilineInput({
    message: 'What should the wallet sign?',
    default: spec.defaultInput ?? '',
  });
  return draft;
}

async function promptField(field: ProofField): Promise<string | undefined> {
  const label = `${field.label}${field.required ? '' : ' (optional)'}`;
  if (field.type === 'select' && field.options && field.options.length > 0) {
    return select<string>({
      message: label,
      choices: field.options.map((opt) => ({ name: opt, value: opt })),
    });
  }
  const value = await input({
    message: label,
    default: field.placeholder ?? '',
    validate: (v) => {
      if (!v.trim() && field.required) return 'Required field.';
      return true;
    },
  });
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

// Combines named fields into a deterministic canonical block. Reused as the
// `input` string passed to the existing artifact builder so the artifact's hash
// and signing message stay stable across re-renders.
export function serializeFields(spec: ProofSpec, fields: Record<string, string>): string {
  const lines = [`${spec.title}`];
  for (const def of spec.fields ?? []) {
    const value = fields[def.id];
    if (value === undefined || value === '') continue;
    lines.push(`${def.label}: ${value}`);
  }
  return lines.join('\n');
}
