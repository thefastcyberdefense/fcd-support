import type { AdminDashboardPort, AdminIdentityPort } from '../../src/admin/admin-app.js';
import type { OperationsView } from '../../src/admin/operations-types.js';
export const operationsTestAt = new Date('2030-01-01T00:00:00.000Z');
export function operationsView(): OperationsView {
  return {
    evaluatedAt: operationsTestAt,
    health: [],
    queues: [],
    incidents: [],
    schemaRevision: '000016',
    deployedRevision: 'a'.repeat(40),
    deploymentState: 'succeeded',
    backup: { state: 'not_verified', createdAt: null, verifiedAt: null },
    restore: { state: 'not_verified', recordedAt: null },
    host: null,
    modelEnabled: false,
    notificationsEnabled: false,
    outboundEnabled: false,
  };
}
export function emptyAdminDashboard(): AdminDashboardPort {
  const done = () => Promise.resolve();
  const list = () => Promise.resolve([]);
  return {
    answerQuestion: done,
    createModelPolicy: done,
    createProposal: done,
    getProposal: () => Promise.reject(new Error('synthetic_unused')),
    listAudit: list,
    listEscalationCounts: list,
    listInsights: list,
    listProposals: list,
    listQuestions: list,
    listModelPolicies: list,
    publishVersion: done,
    retireVersion: done,
    reviewVersion: done,
    rollbackVersion: done,
    submitVersion: done,
    transitionModelPolicy: done,
  };
}
export function syntheticOperationsIdentity(): AdminIdentityPort {
  return {
    beginPasswordAuthentication: () => Promise.resolve({ status: 'denied' }),
    completeMfaAuthentication: () => Promise.resolve({ status: 'denied' }),
    resolveSession: () =>
      Promise.resolve({
        accountRef: 'ADMIN_TEST_health',
        roles: ['administrator'],
        expiresAt: new Date('2030-01-01T01:00:00.000Z'),
      }),
    revokeSession: () => Promise.resolve({ status: 'applied' }),
    validateCsrf: () => Promise.resolve(true),
  };
}
