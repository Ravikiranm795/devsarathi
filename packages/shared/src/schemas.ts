import { z } from 'zod';
import { CONFIG_SCHEMA_VERSION, DEFAULT_IGNORE, DEFAULT_THRESHOLDS } from './constants';

export const StackSchema = z.object({
  id: z.enum(['angular', 'react', 'java', 'python', 'php', 'node']),
  category: z.enum(['frontend', 'backend']),
  /** Repo-relative folder where the stack's manifest lives ('.' for the repo root). */
  dir: z.string().default('.'),
  frameworks: z.array(z.string()).default([]),
  testFramework: z.string().optional(),
  linter: z.string().optional(),
  buildTool: z.string().optional(),
  packageManager: z.string().optional(),
  stateManagement: z.string().optional()
});
export type Stack = z.infer<typeof StackSchema>;

export const ManagedFileSchema = z.object({
  path: z.string(), // repo-relative, posix separators
  hash: z.string(), // sha256 of content as generated
  templateVersion: z.string(),
  source: z.string() // e.g. template@1.0.0
});
export type ManagedFile = z.infer<typeof ManagedFileSchema>;

/** A git hook DevSarathi installed. `backup` holds the original hook it chained onto, restored on uninstall. */
export const GitHookRecordSchema = z.object({
  hook: z.string(),
  path: z.string(), // absolute path of the hook file
  backup: z.string().nullable().default(null), // absolute path of the saved original, when there was one
  hash: z.string() // sha256 of what DevSarathi wrote, to detect later edits
});
export type GitHookRecord = z.infer<typeof GitHookRecordSchema>;

export const ConfigSchema = z.object({
  schemaVersion: z.number().default(CONFIG_SCHEMA_VERSION),
  toolVersion: z.string(),
  baselineBranch: z.string(),
  persona: z.object({ name: z.string(), title: z.string() }),
  stacks: z.array(StackSchema).default([]),
  agents: z
    .object({
      tester: z.boolean().default(true),
      security: z.boolean().default(true),
      'peer-review': z.boolean().default(true),
      auditor: z.boolean().default(true)
    })
    .default({ tester: true, security: true, 'peer-review': true, auditor: true }),
  specsPath: z.string().optional(),
  /** The name each agent goes by (agent id -> name). The developer agent uses persona.name. */
  agentNames: z.record(z.string(), z.string()).default({}),
  /** Claude-drafted, stack-specific guidance added to the agent files (opt-in; kept in enrichment.json). */
  enrich: z.object({ enabled: z.boolean().default(false), at: z.string().optional() }).default({ enabled: false }),
  ignore: z.array(z.string()).default([...DEFAULT_IGNORE]),
  thresholds: z
    .object({
      coverage: z.number().default(DEFAULT_THRESHOLDS.coverage),
      enhanceTargetChars: z.number().default(DEFAULT_THRESHOLDS.enhanceTargetChars),
      enhanceCeilingChars: z.number().default(DEFAULT_THRESHOLDS.enhanceCeilingChars),
      ruleCapPerFile: z.number().default(DEFAULT_THRESHOLDS.ruleCapPerFile),
      baselineCaptureDays: z.number().default(DEFAULT_THRESHOLDS.baselineCaptureDays)
    })
    .default({ ...DEFAULT_THRESHOLDS }),
  /** Per-repo overrides of the stack's default commands, e.g. { test: "npm run test:ci" }. */
  commandOverrides: z.record(z.string(), z.string()).default({}),
  previewPrompt: z.boolean().default(true),
  versionCheck: z.boolean().default(true),
  disabled: z.boolean().default(false), // kill switch (D-31)
  initializedAt: z.string().optional(),
  managedFiles: z.array(ManagedFileSchema).default([]),
  gitHooks: z.array(GitHookRecordSchema).default([]),
  /** Entries DevSarathi added to .git/info/exclude (local-only, never a tracked file). */
  gitExclude: z.array(z.string()).default([]),
  /** Backup of a pre-existing .claude/settings.json made before the hook-entry merge. */
  settingsBackup: z.string().optional(),
  settingsMerged: z.boolean().default(false),
  /** The CLAUDE.md block that makes Claude load the workspace map, persona and core rules. */
  claudeMd: z.object({ file: z.string(), created: z.boolean(), backup: z.string().optional() }).optional(),
  /** Skills installed through the optional skills step (D-26): pinned to a commit, listed so uninstall can remove them. */
  skills: z.array(z.object({ name: z.string(), source: z.string(), commit: z.string(), installedAt: z.string(), files: z.array(z.string()) })).default([])
});
export type DevSarathiConfig = z.infer<typeof ConfigSchema>;

export const BuildRecordSchema = z.object({
  graphFormat: z.number(),
  branch: z.string(),
  commit: z.string(),
  baseline: z.boolean(), // true only when built from the configured baseline branch
  builtAt: z.string(),
  durationMs: z.number(),
  full: z.boolean(),
  coverage: z.object({
    eligibleFiles: z.number(),
    parsedFiles: z.number(),
    ratio: z.number(),
    symbols: z.number(),
    resolvedCallEdges: z.number(),
    unresolvedCalls: z.number()
  }),
  belowThreshold: z.boolean(),
  status: z.enum(['completed', 'failed']),
  error: z.string().optional()
});
export type BuildRecord = z.infer<typeof BuildRecordSchema>;

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  id: z.string(),
  agent: z.enum(['security', 'peer-review', 'tester', 'auditor', 'impact', 'spec']),
  severity: SeveritySchema,
  title: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  detail: z.string().optional(),
  suggestion: z.string().optional(),
  redFlag: z.boolean().default(false)
});
export type Finding = z.infer<typeof FindingSchema>;

/** I-4: a run that did not complete can never read as a pass. */
export const AgentRunSchema = z.object({
  agent: z.enum(['security', 'peer-review', 'tester', 'auditor', 'impact', 'spec']),
  status: z.enum(['completed', 'failed', 'timeout', 'skipped']),
  error: z.string().optional(),
  startedAt: z.string(),
  durationMs: z.number(),
  findings: z.array(FindingSchema).default([])
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const ReviewResultSchema = z.object({
  runId: z.string(),
  createdAt: z.string(),
  branch: z.string(),
  head: z.string(),
  range: z.string(),
  specHash: z.string().optional(),
  specChanged: z.boolean().default(false),
  runs: z.array(AgentRunSchema),
  /** 'clean' only when every enabled agent completed with zero findings. */
  verdict: z.enum(['clean', 'findings', 'incomplete'])
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export type Confidence = 'high' | 'medium' | 'low';
