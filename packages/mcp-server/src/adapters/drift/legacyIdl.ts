import { createHash } from 'node:crypto';

// Converts an Anchor 0.29-style legacy IDL into the shape Anchor 0.31's
// BorshCoder expects. @drift-labs/vaults-sdk@0.11.1 ships its IDL in the legacy
// format even though it peer-deps Anchor 0.31, so we adapt at load time.
// Drop this whole module once the upstream SDK ships a 0.31-spec IDL.

// LegacyIdl is intentionally permissive: the input is whatever shape the SDK
// ships, and the output is what Anchor 0.31 will accept. Internal converter
// logic walks objects defensively.
export type LegacyIdl = Record<string, unknown>;

function sha256First8(preimage: string): number[] {
  return Array.from(createHash('sha256').update(preimage).digest().subarray(0, 8));
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function instructionDiscriminator(name: string): number[] {
  return sha256First8(`global:${snakeCase(name)}`);
}

function accountDiscriminator(name: string): number[] {
  return sha256First8(`account:${name}`);
}

function eventDiscriminator(name: string): number[] {
  return sha256First8(`event:${name}`);
}

function convertType(type: unknown): unknown {
  if (typeof type === 'string') {
    return type === 'publicKey' ? 'pubkey' : type;
  }
  if (type === null || typeof type !== 'object') return type;
  const obj = type as Record<string, unknown>;
  if ('defined' in obj) {
    const defined = obj.defined;
    if (typeof defined === 'string') {
      return { ...obj, defined: { name: defined } };
    }
    return obj;
  }
  if ('option' in obj) return { ...obj, option: convertType(obj.option) };
  if ('vec' in obj) return { ...obj, vec: convertType(obj.vec) };
  if ('coption' in obj) return { ...obj, coption: convertType(obj.coption) };
  if ('array' in obj) {
    const arr = obj.array as [unknown, unknown];
    return { ...obj, array: [convertType(arr[0]), arr[1]] };
  }
  return obj;
}

function convertFields(fields: unknown): unknown {
  if (!Array.isArray(fields)) return fields;
  return fields.map((field) => {
    if (!field || typeof field !== 'object') return field;
    const f = field as Record<string, unknown>;
    return { ...f, type: convertType(f.type) };
  });
}

function convertTypeDef(typeDef: unknown): unknown {
  if (!typeDef || typeof typeDef !== 'object') return typeDef;
  const td = typeDef as Record<string, unknown>;
  if (td.kind === 'struct') {
    return { ...td, fields: convertFields(td.fields) };
  }
  if (td.kind === 'enum' && Array.isArray(td.variants)) {
    return {
      ...td,
      variants: td.variants.map((variant) => {
        if (!variant || typeof variant !== 'object') return variant;
        const v = variant as Record<string, unknown>;
        if (!v.fields) return v;
        return { ...v, fields: convertFields(v.fields) };
      }),
    };
  }
  return td;
}

function convertAccountMeta(account: unknown): unknown {
  if (!account || typeof account !== 'object') return account;
  const a = { ...(account as Record<string, unknown>) };
  if ('isMut' in a) {
    a.writable = Boolean(a.isMut);
    delete a.isMut;
  }
  if ('isSigner' in a) {
    a.signer = Boolean(a.isSigner);
    delete a.isSigner;
  }
  if (Array.isArray(a.accounts)) {
    a.accounts = a.accounts.map(convertAccountMeta);
  }
  return a;
}

export function convertLegacyAnchorIdl<T extends LegacyIdl>(idl: T): T {
  const cloned = structuredClone(idl) as Record<string, unknown>;

  if (Array.isArray(cloned.instructions)) {
    cloned.instructions = cloned.instructions.map((ix) => {
      if (!ix || typeof ix !== 'object') return ix;
      const inst = { ...(ix as Record<string, unknown>) };
      if (Array.isArray(inst.args)) {
        inst.args = inst.args.map((arg) => {
          if (!arg || typeof arg !== 'object') return arg;
          const a = arg as Record<string, unknown>;
          return { ...a, type: convertType(a.type) };
        });
      }
      if (Array.isArray(inst.accounts)) {
        inst.accounts = inst.accounts.map(convertAccountMeta);
      }
      if (!('discriminator' in inst) && typeof inst.name === 'string') {
        inst.discriminator = instructionDiscriminator(inst.name);
      }
      return inst;
    });
  }

  const types: Array<Record<string, unknown>> = Array.isArray(cloned.types)
    ? (cloned.types as unknown[]).map((entry) => {
        const t = entry as Record<string, unknown>;
        return { ...t, type: convertTypeDef(t.type) };
      })
    : [];

  if (Array.isArray(cloned.accounts)) {
    cloned.accounts = cloned.accounts.map((acc) => {
      if (!acc || typeof acc !== 'object') return acc;
      const a = { ...(acc as Record<string, unknown>) };
      const name = a.name as string;
      const embedded = a.type as unknown;
      if (!('discriminator' in a) && typeof name === 'string') {
        a.discriminator = accountDiscriminator(name);
      }
      if (embedded && typeof name === 'string' && !types.some((t) => t.name === name)) {
        types.push({ name, type: convertTypeDef(embedded) });
      }
      delete a.type;
      return a;
    });
  }

  if (Array.isArray(cloned.events)) {
    cloned.events = cloned.events.map((evt) => {
      if (!evt || typeof evt !== 'object') return evt;
      const e = { ...(evt as Record<string, unknown>) };
      const name = e.name as string;
      const fields = e.fields;
      if (!('discriminator' in e) && typeof name === 'string') {
        e.discriminator = eventDiscriminator(name);
      }
      if (Array.isArray(fields) && typeof name === 'string' && !types.some((t) => t.name === name)) {
        types.push({
          name,
          type: { kind: 'struct', fields: convertFields(fields) as unknown[] },
        });
      }
      delete e.fields;
      return e;
    });
  }

  cloned.types = types;
  return cloned as T;
}
