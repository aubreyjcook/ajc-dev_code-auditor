/**
 * @module analysis/prompts/security
 *
 * Security review prompt. Aligned with OWASP Top 10 (web) and common CWE
 * classes; asks for CWE/OWASP references so findings can be triaged against
 * existing policies.
 */

import type { PromptBuilder } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './shared.js';

export const securityPrompt: PromptBuilder = (ctx) => {
  const codeFocus = [
    'Injection: SQL/NoSQL/command/LDAP/template injection, unsafe deserialisation, eval of untrusted input (CWE-89, CWE-78, CWE-94, CWE-502)',
    'Cross-site scripting and unsafe HTML rendering (innerHTML, dangerouslySetInnerHTML, unescaped templates) (CWE-79)',
    'Authentication and session flaws: weak password handling, missing rate limiting, insecure token generation, JWT misuse, missing auth checks on routes (CWE-287, CWE-306, CWE-384)',
    'Broken access control / IDOR: object access without ownership checks (CWE-639, CWE-862)',
    'Hard-coded secrets, API keys, credentials, private keys committed to source (CWE-798) - redact the value in evidence',
    'Cryptography misuse: MD5/SHA1 for passwords, ECB mode, static IVs, Math.random for security purposes (CWE-327, CWE-330)',
    'Insecure configuration: debug mode, permissive CORS, disabled TLS verification, verbose errors to clients, default credentials (CWE-16)',
    'Path traversal, unrestricted file upload, SSRF, open redirect (CWE-22, CWE-434, CWE-918, CWE-601)',
    'Dependency and supply-chain risk visible in manifests (pinned vulnerable versions, install scripts, unpinned remote installs)',
    'Missing input validation at trust boundaries (HTTP handlers, CLI args, file parsing, message consumers)',
    'Secrets or PII written to logs',
  ];
  const webFocus = [
    'Missing or weak security headers: Content-Security-Policy, Strict-Transport-Security, X-Frame-Options / frame-ancestors, X-Content-Type-Options, Referrer-Policy, Permissions-Policy',
    'Cookie hygiene: session cookies without Secure / HttpOnly / SameSite; sensitive data in cookies or localStorage visible in inline scripts',
    'Forms: credential or payment forms without CSRF tokens, posting over HTTP, to third-party origins, or autocomplete on sensitive fields',
    'Mixed content, insecure third-party scripts loaded without Subresource Integrity, excessive third-party hosts',
    'Information disclosure: server/framework versions in headers, stack traces, debug endpoints, source maps, exposed .git/.env paths referenced in markup',
    'Client-side secrets: API keys, tokens, or internal endpoints embedded in inline scripts or data attributes',
    'Clickjacking exposure, open redirects visible in links, reflected parameters in page content',
    'Console errors or failed requests that hint at misconfiguration (CORS failures, blocked by CSP, 401/403 to APIs)',
    'Authentication UX risks visible in markup: password fields without autocomplete="current-password"/"new-password", login over plain HTTP',
  ];
  const system = buildSystemPrompt(ctx, {
    role: 'senior application security engineer performing a code and configuration review',
    focus: ctx.targetKind === 'code' ? codeFocus : webFocus,
    avoid: [
      'Generic advice not tied to a specific location in the material',
      'Style or formatting issues (other categories cover those)',
      'Theoretical issues in test fixtures or example files unless they contain real credentials',
    ],
    extra:
      'Include "references" with CWE and/or OWASP identifiers for each finding where applicable. If a secret appears to be a real credential, set severity to at least "high" and redact it in evidence.',
  });
  return { system, user: buildUserPrompt(ctx) };
};
