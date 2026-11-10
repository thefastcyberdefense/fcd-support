## Summary

- What changed and why?
- Which approved plan/tracker/handoff reference does this implement?

## Scope and Publication Safety

- [ ] No production WhatsApp number, token, customer data, or private support content changed.
- [ ] Webhook-only public exposure (`GET /webhooks/meta` and `POST /webhooks/meta`) and private admin/health/database/Manifest/n8n boundaries are preserved.
- [ ] Approved FAQ precedence and tool-free Manifest `fcd-support` fallback (`model: "auto"`) are preserved; draft/rejected/retired/admin/webhook data cannot enter customer replies.

## Validation

Commands run (paste exact commands and outcomes):

- [ ] `npm run validate:phase0`
- [ ] `npm run format:check`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm audit --omit=dev --audit-level=high`

## Evidence

- Phase/tracker/handoff links:
- Test or CI run evidence:
- UI/SEO or runtime/migration evidence (if applicable):

## Security, SEO and Accessibility Impact

- Threat-model/retention/consent impact:
- Crawler isolation or public-exposure impact (if applicable):
- Admin UI/accessibility impact (if applicable):
- Rollback plan:
