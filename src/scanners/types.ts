/**
 * @module scanners/types
 *
 * Data model shared by the code and web scanners. Scanners produce a
 * {@link ScanResult}; the analysis layer consumes it without caring whether
 * the items came from a filesystem or a browser.
 */

/** One unit of material to analyse: a source file or a crawled page. */
export interface ScanItem {
  /** `file` for codebase targets, `page` for web targets. */
  kind: 'file' | 'page';
  /** Repository-relative POSIX path for files; absolute URL for pages. */
  id: string;
  /** Text that will be shown to the model (source code, or a page digest). */
  content: string;
  /** Estimated token count of `content`, used by the chunker. */
  tokens: number;
  /** Size in bytes of the original material. */
  bytes: number;
  /** Language / content-type hint (e.g. `typescript`, `html`). */
  language?: string;
  /** Arbitrary extra metadata (HTTP status, depth, axe summary, ...). */
  meta?: Record<string, unknown>;
}

/** Broad grouping for detected technologies. */
export type TechCategory =
  | 'language'
  | 'framework'
  | 'library'
  | 'runtime'
  | 'build'
  | 'test'
  | 'ci'
  | 'infra'
  | 'database'
  | 'analytics'
  | 'cdn'
  | 'server'
  | 'cms'
  | 'other';

/** A technology detected deterministically (not by the LLM). */
export interface TechSignal {
  name: string;
  category: TechCategory;
  version?: string;
  /** Where/how it was detected, e.g. `package.json dependencies` or `x-powered-by header`. */
  evidence: string;
  /** 0..1 */
  confidence: number;
}

/** Kinds of ownership / authorship indicators. */
export type OwnershipKind =
  | 'author'
  | 'maintainer'
  | 'copyright'
  | 'license'
  | 'email'
  | 'domain'
  | 'repository'
  | 'organization'
  | 'codeowners'
  | 'git-author'
  | 'contact'
  | 'legal'
  | 'security-contact';

/** An indicator of who owns or authored the material. */
export interface OwnershipSignal {
  kind: OwnershipKind;
  value: string;
  /** File path or URL where it was found. */
  source: string;
  /** Short surrounding context. */
  context?: string;
  /** 0..1 */
  confidence: number;
}

/** Per-author commit statistics (code targets with git history only). */
export interface GitAuthorStat {
  name: string;
  email: string;
  commits: number;
  firstCommit?: string;
  lastCommit?: string;
}

/** Description of what was scanned. */
export interface ScanTarget {
  kind: 'code' | 'web';
  /** What the user typed: path, git URL, or web URL. */
  source: string;
  /** Local directory that was read (code) or start URL (web). */
  resolved: string;
  /** True when a git URL was cloned to a temporary directory. */
  cloned?: boolean;
  /** Git remote URL if discovered. */
  remote?: string;
  /** Git branch if discovered. */
  branch?: string;
}

/** Aggregate numbers for the terminal summary and report header. */
export interface ScanStats {
  itemsScanned: number;
  itemsSkipped: number;
  totalBytes: number;
  totalTokens: number;
  /** Extension or content-type histogram. */
  byLanguage: Record<string, number>;
  durationMs: number;
}

/** Everything a scanner hands to the analysis layer. */
export interface ScanResult {
  target: ScanTarget;
  items: ScanItem[];
  tech: TechSignal[];
  ownership: OwnershipSignal[];
  gitAuthors?: GitAuthorStat[];
  stats: ScanStats;
  /** Human-readable notes about the scan (what was skipped, warnings). */
  notes: string[];
  /** Web only: axe-core violations per page in a compact form. */
  accessibility?: AxePageSummary[];
}

/** Compact axe-core result for one page. */
export interface AxePageSummary {
  url: string;
  violations: {
    id: string;
    impact: 'minor' | 'moderate' | 'serious' | 'critical' | null | undefined;
    description: string;
    help: string;
    helpUrl: string;
    nodes: { target: string; html: string }[];
  }[];
  passes: number;
  incomplete: number;
}
