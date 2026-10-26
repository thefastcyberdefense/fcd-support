import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminRole, ResolvedAdminSession } from '../persistence/postgres-admin-identity.js';
import type { AdminActor } from './admin-app.js';
import type { AdminAction } from './admin-action.js';
import type { AdminSecretText } from './admin-types.js';
import { renderOperationsPage } from './operations-html.js';
import type { AdminOperationsPort } from './operations-types.js';

interface Context {
  readonly actor: AdminActor;
  readonly csrfToken: string;
  readonly session: ResolvedAdminSession;
  readonly sessionToken: AdminSecretText;
}
export interface AdminOperationsDependencies {
  readonly operations: AdminOperationsPort;
  readonly requireSession: (
    request: FastifyRequest,
    reply: FastifyReply,
    roles: readonly AdminRole[],
  ) => Promise<Context | undefined>;
  readonly requireMutation: (
    request: FastifyRequest,
    reply: FastifyReply,
    roles: readonly AdminRole[],
  ) => Promise<(Context & { readonly form: Readonly<Record<string, string>> }) | undefined>;
  readonly issueAction: (
    context: Context,
    action: AdminAction['action'],
    reference: string,
  ) => string;
  readonly readAction: (
    context: Context & { readonly form: Readonly<Record<string, string>> },
    action: AdminAction['action'],
    reference: string,
  ) => AdminAction;
  readonly invalidForm: () => never;
  readonly nonce: () => string;
  readonly html: (reply: FastifyReply, nonce: string, body: string) => unknown;
  readonly redirect: (reply: FastifyReply, location: string) => unknown;
}
export function registerOperationsRoutes(
  app: FastifyInstance,
  dependencies: AdminOperationsDependencies,
): void {
  app.get('/operations', async (request, reply) => {
    const context = await dependencies.requireSession(request, reply, ['administrator']);
    if (context === undefined) return;
    const view = await dependencies.operations.read(context.actor);
    const tokens: Record<string, string> = {};
    for (const incident of view.incidents)
      if (incident.acknowledgedAt === null && incident.resolvedAt === null)
        tokens[incident.incidentRef] = dependencies.issueAction(
          context,
          'incident_acknowledge',
          incident.incidentRef,
        );
    const nonce = dependencies.nonce();
    return dependencies.html(
      reply,
      nonce,
      renderOperationsPage({
        view,
        nonce,
        csrfToken: context.csrfToken,
        session: context.session,
        actionTokens: tokens,
      }),
    );
  });
  app.post('/operations/incidents/:incidentRef/acknowledge', async (request, reply) => {
    const context = await dependencies.requireMutation(request, reply, ['administrator']);
    if (context === undefined) return;
    const reference = (request.params as Record<string, unknown>).incidentRef;
    if (typeof reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(reference))
      dependencies.invalidForm();
    const action = dependencies.readAction(context, 'incident_acknowledge', reference);
    await dependencies.operations.acknowledgeIncident(
      {
        incidentRef: reference,
        requestKey: action.requestKey,
        acknowledgedAt: new Date(action.effectiveAt),
      },
      context.actor,
    );
    return dependencies.redirect(reply, '/operations');
  });
}
