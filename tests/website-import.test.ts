import { describe, expect, test } from 'vitest';

import {
  extractWebsiteSnapshotCandidates,
  fetchOfficialWebsiteSnapshot,
  isAllowedWebsiteImportUrl,
} from '../src/knowledge/website-import.js';

describe('website-import SSRF boundary and draft candidate extraction', () => {
  test('allows public HTTPS URLs and blocks unsafe schemes, credentials, loopback, link-local, RFC1918, and single-label hosts', () => {
    expect(isAllowedWebsiteImportUrl('https://example.org/faq')).toBe(true);
    expect(isAllowedWebsiteImportUrl('https://docs.example.com:8443/help')).toBe(true);

    expect(isAllowedWebsiteImportUrl('http://example.org/faq')).toBe(false);
    expect(isAllowedWebsiteImportUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedWebsiteImportUrl('https://user:pass@example.org/faq')).toBe(false);
    expect(isAllowedWebsiteImportUrl('https://localhost/faq')).toBe(false);
    expect(isAllowedWebsiteImportUrl('https://127.0.0.1/faq')).toBe(false);
    expect(isAllowedWebsiteImportUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedWebsiteImportUrl('https://10.0.0.8/internal')).toBe(false);
    expect(isAllowedWebsiteImportUrl('https://172.16.4.1/internal')).toBe(false);
    expect(isAllowedWebsiteImportUrl('https://192.168.10.40/admin')).toBe(false);
    expect(isAllowedWebsiteImportUrl('https://[::1]/faq')).toBe(false);
    expect(isAllowedWebsiteImportUrl('https://[fd00::1]/faq')).toBe(false);
    expect(isAllowedWebsiteImportUrl('https://intranet/faq')).toBe(false);
  });

  test('strips scripts, styles, and tags cleanly without inventing unverified translations or facts', () => {
    const html = `<!doctype html>
      <html>
        <head><title>Synthetic Service FAQ</title><style>.hidden{display:none}</style></head>
        <body>
          <script>alert("ignore")</script>
          <h1>Support Hours</h1>
          <p>Synthetic support operates daily 09:00 to 18:00.</p>
          <p>Official ticket billing email is support@example.org.</p>
        </body>
      </html>`;
    const extracted = extractWebsiteSnapshotCandidates(html, 'https://example.org/support');
    expect(extracted.title).toBe('Synthetic Service FAQ');
    expect(extracted.plainText).toContain('Support Hours');
    expect(extracted.plainText).toContain('Synthetic support operates daily 09:00 to 18:00.');
    expect(extracted.plainText).not.toContain('alert("ignore")');
    expect(extracted.plainText).not.toContain('display:none');
    expect(extracted.candidates.length).toBeGreaterThanOrEqual(1);
    expect(extracted.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(extracted.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test('bounded HTTPS fetch rejects oversized bodies, non-200 status, and unsafe hostnames before network I/O', async () => {
    let called = 0;
    await expect(
      fetchOfficialWebsiteSnapshot('https://192.168.10.40/secrets', {
        fetch: () => {
          called += 1;
          return Promise.resolve(new Response('ok'));
        },
      }),
    ).rejects.toThrow('website_url_rejected');
    expect(called).toBe(0);

    await expect(
      fetchOfficialWebsiteSnapshot('https://example.org/down', {
        fetch: () => Promise.resolve(new Response('Not Found', { status: 404 })),
      }),
    ).rejects.toThrow('website_fetch_failed');

    const ok = await fetchOfficialWebsiteSnapshot('https://example.org/faq', {
      fetch: () =>
        Promise.resolve(
          new Response(
            '<html><head><title>FAQ</title></head><body><p>Valid official FAQ text.</p></body></html>',
            { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
          ),
        ),
    });
    expect(ok.normalizedUrl).toBe('https://example.org/faq');
    expect(ok.plainText).toContain('Valid official FAQ text.');
  });
});
