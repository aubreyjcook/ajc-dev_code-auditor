/**
 * @module report/json
 *
 * JSON serialisation of the report. The structure is {@link AuditReport}
 * verbatim (schemaVersion 1), pretty-printed for diff-friendliness.
 */

import type { AuditReport } from './types.js';

/** Serialises the report to a JSON string. */
export function renderJson(report: AuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
