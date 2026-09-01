import type { KnowledgePublicationCommand, KnowledgeReviewCommand } from './knowledge-types.js';
import type { ReviewerPrincipal } from '../policy/policy-types.js';
import {
  PolicyAuthorizationError,
  requireKnowledgeEditor,
  requireKnowledgeReviewer,
} from '../policy/reviewer-principal.js';

function requireActorMatch(principal: ReviewerPrincipal, reviewerReference: string): void {
  if (principal.reviewerRef !== reviewerReference) {
    throw new PolicyAuthorizationError('Knowledge reviewer identity mismatch');
  }
}

export function authorizeKnowledgeReview(
  command: KnowledgeReviewCommand,
  principalInput: unknown,
): ReviewerPrincipal {
  const principal =
    command.action === 'submit'
      ? requireKnowledgeEditor(principalInput)
      : requireKnowledgeReviewer(principalInput);
  requireActorMatch(principal, command.reviewerReference);
  return principal;
}

export function authorizeKnowledgePublication(
  command: KnowledgePublicationCommand,
  principalInput: unknown,
): ReviewerPrincipal {
  const principal = requireKnowledgeReviewer(principalInput);
  requireActorMatch(principal, command.reviewerReference);
  return principal;
}
