import { expect, test } from 'vitest';

import { auditUiUxContract } from '../scripts/verify-ui-ux-contract.js';

test('strict UI/UX contract passes all accessibility, touch target, dark theme, and responsive table rules', async () => {
  const result = await auditUiUxContract({ strictMode: true });
  expect(result.findings).toEqual([]);
  expect(result.ok).toBe(true);
});
