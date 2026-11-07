/**
 * @module index
 *
 * Library entry point. Everything the CLI uses is also available
 * programmatically:
 *
 * ```ts
 * import { runAudit, loadConfig } from 'ajc-dev-code-auditor';
 *
 * const config = loadConfig({ cliOverrides: { llm: { provider: 'groq' } } });
 * const { report } = await runAudit({ kind: 'code', source: './repo', config, noWrite: true });
 * console.log(report.findings.length);
 * ```
 */

export * from './config/index.js';
export * from './llm/index.js';
export * from './analysis/index.js';
export * from './report/index.js';
export * from './scanners/types.js';
export { scanCode } from './scanners/code/index.js';
export { scanWeb, buildPageDigest } from './scanners/web/index.js';
export { runAudit, toolInfo } from './audit.js';
export type { RunAuditOptions, RunAuditResult } from './audit.js';
export { log, setLogLevel } from './util/logger.js';
