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
  validateRecordId,
  validateUpdatePlanRequest,
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
  | { name: 'completed' }
  | { name: 'completed-record'; id: string };

function matchWorkflowRoute(pathname: string): WorkflowRoute | undefined {
  if (pathname === '/api/plans') return { name: 'plans' };
  const plan = /^\/api\/plans\/([^/]+)$/.exec(pathname);
  if (plan?.[1]) return { name: 'plan', id: validateRecordId(plan[1], 'plan id') };

  if (pathname === '/api/approvals') return { name: 'approvals' };
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
