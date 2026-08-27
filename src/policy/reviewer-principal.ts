import { z } from 'zod';

import type { ReviewerPrincipal } from './policy-types.js';

const reviewerPrincipalSchema = z.strictObject({
  reviewerRef: z.string().trim().min(1).max(128),
  roles: z.array(z.string().trim().min(1).max(64)).max(16),
});

export class PolicyAuthorizationError extends Error {
  public constructor() {
    super('Support reviewer role required');
    this.name = 'PolicyAuthorizationError';
  }
}

export class PolicyOwnerAuthorizationError extends Error {
  public constructor() {
    super('Policy owner role required');
    this.name = 'PolicyOwnerAuthorizationError';
  }
}

export function requireSupportReviewer(input: unknown): ReviewerPrincipal {
  const principal = reviewerPrincipalSchema.parse(input);

  if (!principal.roles.includes('support_reviewer')) {
    throw new PolicyAuthorizationError();
  }

  return principal;
}

export function requirePolicyOwner(input: unknown): ReviewerPrincipal {
  const principal = reviewerPrincipalSchema.parse(input);

  if (!principal.roles.includes('policy_owner')) {
    throw new PolicyOwnerAuthorizationError();
  }

  return principal;
}
