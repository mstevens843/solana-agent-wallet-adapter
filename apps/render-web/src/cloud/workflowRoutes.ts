import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  WorkflowService,
  WorkflowServiceError,
  type WorkflowStore,
} from './workflowService.js';
import {
  WorkflowValidationError,
  isApprovalDecision,
  validateApprovalDecisionRequest,
  validateCreateApprovalRequest,
  validateCreatePlanRequest,
  validateCreateTransactionFinalizationPreviewRequest,
  validateRecordId,
  validateRecordTransactionFinalizationResultRequest,
  validateUpdatePlanRequest,
  type JsonObject,
  type WorkflowSession,
} from './workflowValidation.js';
import { redactSecrets } from './redaction.js';

const MAX_JSON_BYTES = 64 * 1024;

export interface WorkflowRouteContext {
  store?: WorkflowStore;
  service?: WorkflowService;
  getSession(req: IncomingMessage): Promise<WorkflowSession | null | undefined> | WorkflowSession | null | undefined;
}

type WorkflowHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createWorkflowApiHandler(context: WorkflowRouteContext): WorkflowHandler {
  const service = context.service ?? (context.store ? new WorkflowService(context.store) : undefined);
  if (!service) {
    throw new Error('Workflow API handler requires a workflow service or store.');
  }

  return async (req, res) => handleWorkflowApiRequest(req, res, {
    service,
    getSession: context.getSession,
  });
}

export async function handleWorkflowApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: Required<Pick<WorkflowRouteContext, 'service' | 'getSession'>>,
): Promise<boolean> {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = matchWorkflowRoute(url.pathname);
    if (!route) return false;

    const session = await context.getSession(req);
    if (!session?.walletAddress) {
      writeJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    switch (route.name) {
      case 'plans':
        await handlePlans(req, res, context.service, session);
        return true;
      case 'plan':
        await handlePlan(req, res, context.service, session, route.id);
        return true;
      case 'approvals':
        await handleApprovals(req, res, context.service, session);
        return true;
      case 'approval-decision':
        await handleApprovalDecision(req, res, context.service, session, route.id, route.decision);
        return true;
      case 'approval-wallet-execution':
        await handleApprovalWalletExecution(req, res, context.service, session, route.id);
        return true;
      case 'approval-finalizations':
        await handleApprovalFinalizations(req, res, context.service, session, route.id);
        return true;
      case 'approval-finalization-prepare':
        await handleApprovalFinalizationPrepare(req, res, context.service, session, route.id);
        return true;
      case 'approval-finalization-submit':
        await handleApprovalFinalizationSubmit(req, res, context.service, session, route.id, route.finalizationId);
        return true;
      case 'approval-finalization-confirm':
        await handleApprovalFinalizationConfirm(req, res, context.service, session, route.id, route.finalizationId);
        return true;
      case 'approval-finalization-fail':
        await handleApprovalFinalizationFail(req, res, context.service, session, route.id, route.finalizationId);
        return true;
      case 'approval-finalization-preview':
        await handleApprovalFinalizationPreview(req, res, context.service, session, route.id);
        return true;
      case 'approval-finalization-result':
        await handleApprovalFinalizationResult(req, res, context.service, session, route.id);
        return true;
      case 'completed':
        await handleCompleted(req, res, context.service, session);
        return true;
      case 'completed-record':
        await handleCompletedRecord(req, res, context.service, session, route.id);
        return true;
    }
  } catch (err) {
    writeRouteError(res, err);
    return true;
  }
}

type WorkflowRoute =
  | { name: 'plans' }
  | { name: 'plan'; id: string }
  | { name: 'approvals' }
  | { name: 'approval-decision'; id: string; decision: 'approved' | 'rejected' | 'cancelled' }
  | { name: 'approval-wallet-execution'; id: string }
  | { name: 'approval-finalizations'; id: string }
  | { name: 'approval-finalization-prepare'; id: string }
  | { name: 'approval-finalization-submit'; id: string; finalizationId: string }
  | { name: 'approval-finalization-confirm'; id: string; finalizationId: string }
  | { name: 'approval-finalization-fail'; id: string; finalizationId: string }
  | { name: 'approval-finalization-preview'; id: string }
  | { name: 'approval-finalization-result'; id: string }
  | { name: 'completed' }
  | { name: 'completed-record'; id: string };

function matchWorkflowRoute(pathname: string): WorkflowRoute | undefined {
  if (pathname === '/api/plans') return { name: 'plans' };
  const plan = /^\/api\/plans\/([^/]+)$/.exec(pathname);
  if (plan?.[1]) return { name: 'plan', id: validateRecordId(plan[1], 'plan id') };

  if (pathname === '/api/approvals') return { name: 'approvals' };
  const walletExecution = /^\/api\/approvals\/([^/]+)\/wallet-execution$/.exec(pathname);
  if (walletExecution?.[1]) {
    return {
      name: 'approval-wallet-execution',
      id: validateRecordId(walletExecution[1], 'approval id'),
    };
  }
  const finalizationPrepare = /^\/api\/approvals\/([^/]+)\/finalization\/prepare$/.exec(pathname);
  if (finalizationPrepare?.[1]) {
    return {
      name: 'approval-finalization-prepare',
      id: validateRecordId(finalizationPrepare[1], 'approval id'),
    };
  }
  const finalizationSubmit = /^\/api\/approvals\/([^/]+)\/finalization\/([^/]+)\/submit$/.exec(pathname);
  if (finalizationSubmit?.[1] && finalizationSubmit[2]) {
    return {
      name: 'approval-finalization-submit',
      id: validateRecordId(finalizationSubmit[1], 'approval id'),
      finalizationId: validateRecordId(finalizationSubmit[2], 'finalization id'),
    };
  }
  const finalizationConfirm = /^\/api\/approvals\/([^/]+)\/finalization\/([^/]+)\/confirm$/.exec(pathname);
  if (finalizationConfirm?.[1] && finalizationConfirm[2]) {
    return {
      name: 'approval-finalization-confirm',
      id: validateRecordId(finalizationConfirm[1], 'approval id'),
      finalizationId: validateRecordId(finalizationConfirm[2], 'finalization id'),
    };
  }
  const finalizationFail = /^\/api\/approvals\/([^/]+)\/finalization\/([^/]+)\/fail$/.exec(pathname);
  if (finalizationFail?.[1] && finalizationFail[2]) {
    return {
      name: 'approval-finalization-fail',
      id: validateRecordId(finalizationFail[1], 'approval id'),
      finalizationId: validateRecordId(finalizationFail[2], 'finalization id'),
    };
  }
  const finalizationPreview = /^\/api\/approvals\/([^/]+)\/finalization\/preview$/.exec(pathname);
  if (finalizationPreview?.[1]) {
    return {
      name: 'approval-finalization-preview',
      id: validateRecordId(finalizationPreview[1], 'approval id'),
    };
  }
  const finalizationResult = /^\/api\/approvals\/([^/]+)\/finalization\/result$/.exec(pathname);
  if (finalizationResult?.[1]) {
    return {
      name: 'approval-finalization-result',
      id: validateRecordId(finalizationResult[1], 'approval id'),
    };
  }
  const finalizations = /^\/api\/approvals\/([^/]+)\/finalization$/.exec(pathname);
  if (finalizations?.[1]) {
    return {
      name: 'approval-finalizations',
      id: validateRecordId(finalizations[1], 'approval id'),
    };
  }
  const approvalDecision = /^\/api\/approvals\/([^/]+)\/(approve|deny|cancel)$/.exec(pathname);
  if (approvalDecision?.[1] && approvalDecision[2]) {
    const decision = routeDecisionToStatus(approvalDecision[2]);
    return {
      name: 'approval-decision',
      id: validateRecordId(approvalDecision[1], 'approval id'),
      decision,
    };
  }

  if (pathname === '/api/completed') return { name: 'completed' };
  const completed = /^\/api\/completed\/([^/]+)$/.exec(pathname);
  if (completed?.[1]) return { name: 'completed-record', id: validateRecordId(completed[1], 'completed id') };
  return undefined;
}

async function handlePlans(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
): Promise<void> {
  if (req.method === 'POST') {
    const plan = await service.createPlan(session, validateCreatePlanRequest(await readJsonBody(req)));
    writeJson(res, 201, { plan });
    return;
  }
  if (req.method === 'GET') {
    writeJson(res, 200, { plans: await service.listPlans(session) });
    return;
  }
  methodNotAllowed(res);
}

async function handlePlan(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
): Promise<void> {
  if (req.method === 'PATCH') {
    const plan = await service.updatePlan(session, id, validateUpdatePlanRequest(await readJsonBody(req)));
    writeJson(res, 200, { plan });
    return;
  }
  if (req.method === 'DELETE') {
    await service.deletePlan(session, id);
    writeJson(res, 200, { ok: true });
    return;
  }
  methodNotAllowed(res);
}

async function handleApprovals(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
): Promise<void> {
  if (req.method === 'POST') {
    const approval = await service.createApproval(session, validateCreateApprovalRequest(await readJsonBody(req)));
    writeJson(res, 201, { approval });
    return;
  }
  if (req.method === 'GET') {
    writeJson(res, 200, { approvals: await service.listActiveApprovals(session) });
    return;
  }
  methodNotAllowed(res);
}

async function handleApprovalDecision(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
  decision: 'approved' | 'rejected' | 'cancelled',
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  const result = await service.decideApproval(
    session,
    id,
    decision,
    validateApprovalDecisionRequest(await readJsonBody(req)),
  );
  writeJson(res, 200, result);
}

async function handleApprovalWalletExecution(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  const result = await service.recordWalletExecution(
    session,
    id,
    validateApprovalDecisionRequest(await readJsonBody(req)),
  );
  writeJson(res, 200, result);
}

async function handleApprovalFinalizations(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
): Promise<void> {
  if (req.method !== 'GET') {
    methodNotAllowed(res);
    return;
  }
  writeJson(res, 200, { finalizations: await service.listFinalizationsForApproval(session, id) });
}

async function handleApprovalFinalizationPrepare(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  writeJson(res, 201, await service.prepareTransactionFinalization(session, id));
}

async function handleApprovalFinalizationSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
  finalizationId: string,
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  const result = await service.submitTransactionFinalization(
    session,
    id,
    finalizationId,
    validateRecordTransactionFinalizationResultRequest(bodyWithRouteFinalizationId(await readJsonBody(req), finalizationId)),
  );
  writeJson(res, 200, result);
}

async function handleApprovalFinalizationConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
  finalizationId: string,
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  await readJsonBody(req);
  const result = await service.confirmTransactionFinalization(session, id, finalizationId);
  writeJson(res, 200, result);
}

async function handleApprovalFinalizationFail(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
  finalizationId: string,
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  const result = await service.failTransactionFinalization(
    session,
    id,
    finalizationId,
    validateFinalizationFailureRequest(await readJsonBody(req)),
  );
  writeJson(res, 200, result);
}

async function handleApprovalFinalizationPreview(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  const result = await service.createFinalizationPreview(
    session,
    id,
    validateCreateTransactionFinalizationPreviewRequest(await readJsonBody(req)),
  );
  writeJson(res, 201, result);
}

async function handleApprovalFinalizationResult(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  const result = await service.recordFinalizationResult(
    session,
    id,
    validateRecordTransactionFinalizationResultRequest(await readJsonBody(req)),
  );
  writeJson(res, 200, result);
}

async function handleCompleted(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
): Promise<void> {
  if (req.method !== 'GET') {
    methodNotAllowed(res);
    return;
  }
  writeJson(res, 200, { completed: await service.listCompleted(session) });
}

async function handleCompletedRecord(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkflowService,
  session: WorkflowSession,
  id: string,
): Promise<void> {
  if (req.method !== 'DELETE') {
    methodNotAllowed(res);
    return;
  }
  await service.deleteCompleted(session, id);
  writeJson(res, 200, { ok: true });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new WorkflowValidationError('body_too_large', 'Request body is too large.');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new WorkflowValidationError('invalid_json', 'Request body must be valid JSON.');
  }
}

function bodyWithRouteFinalizationId(body: unknown, finalizationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { finalizationId };
  }
  return { ...(body as Record<string, unknown>), finalizationId };
}

function validateFinalizationFailureRequest(body: unknown): { error?: string; note?: string; metadata?: JsonObject } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WorkflowValidationError('invalid_body', 'Request body must be a JSON object.');
  }
  const input = body as Record<string, unknown>;
  const error = optionalBodyString(input.error, 'error');
  const note = optionalBodyString(input.note, 'note');
  const metadata = input.metadata === undefined ? undefined : jsonObjectBody(input.metadata, 'metadata');
  return {
    ...(error ? { error } : {}),
    ...(note ? { note } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function optionalBodyString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', `${label} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function jsonObjectBody(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_json_object', `${label} must be a JSON object.`);
  }
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function routeDecisionToStatus(value: string): 'approved' | 'rejected' | 'cancelled' {
  const status = value === 'approve' ? 'approved' : value === 'deny' ? 'rejected' : 'cancelled';
  if (!isApprovalDecision(status)) {
    throw new WorkflowValidationError('invalid_decision', 'Approval decision route is invalid.');
  }
  return status;
}

function methodNotAllowed(res: ServerResponse): void {
  writeJson(res, 405, { error: 'method_not_allowed' });
}

function writeRouteError(res: ServerResponse, err: unknown): void {
  if (err instanceof WorkflowValidationError) {
    writeJson(res, err.code === 'body_too_large' ? 413 : 400, { error: err.code, message: err.message });
    return;
  }
  if (err instanceof WorkflowServiceError) {
    writeJson(res, err.status, { error: err.code, message: err.message });
    return;
  }
  const message = err instanceof Error ? redactSecrets(err.message) : 'Unexpected workflow API error.';
  writeJson(res, 500, { error: 'internal_error', message });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
