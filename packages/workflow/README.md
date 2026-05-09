# Agentic Workflow Contracts

Shared TypeScript contracts for Agentic Cloud workflow state.

This package models unsigned workflow state only: plan drafts, approval requests, recurring schedules, completed records, evidence receipts, and audit events. It must not model seed phrases, private keys, delegated signing authority, or silently executable transactions.

## Validator Shape

- `parse*` functions are strict parsers for trusted records and API responses. They preserve the wire shape and throw `WorkflowValidationError` with stable `code` and `path` fields for invalid JSON.
- `validate*` functions normalize untrusted route input before services store it. They trim user-facing strings, coerce JSON objects, reject empty mutable patches, and block private keys, seed phrases, delegated signers, and unlimited approval authority.
- Auth request parsing may add stronger app-level checks outside this package, such as Solana public-key normalization. Workflow, recurring, completed, and evidence request contracts should stay canonical here.
