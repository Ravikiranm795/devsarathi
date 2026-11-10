export const TOOL_NAME = 'DevSarathi';
export const BRAIN_NAME = 'Drishti';
export const NPM_PACKAGE = '@ravikiranm795/dev-sarathi';
export const CLI_NAME = 'devsarathi';
export const MIN_NODE_MAJOR = 20;

/** Every file DevSarathi creates inside a repo's `.claude` folder starts with this. */
export const FILE_PREFIX = 'ds-';

/** Folder (inside the target repo) that holds DevSarathi's own state. */
export const STATE_DIR = '.claude/devsarathi';

export const CONFIG_SCHEMA_VERSION = 1;
export const GRAPH_FORMAT_VERSION = 1;
export const TEMPLATE_VERSION = '1.0.0';

export const DEFAULT_IGNORE = [
  'node_modules', 'dist', 'build', 'target', 'out', '.next', '.angular', 'coverage', 'vendor',
  '__pycache__', '.venv', 'venv', '.gradle', '.idea', '.git'
];

export const DEFAULT_THRESHOLDS = {
  coverage: 0.8,
  enhanceTargetChars: 400,
  enhanceCeilingChars: 1500,
  ruleCapPerFile: 40,
  baselineCaptureDays: 7
};

export const BASELINE_BRANCH_CANDIDATES = ['development', 'develop', 'dev', 'main', 'master'];

export type StackId = 'angular' | 'react' | 'java' | 'python' | 'php' | 'node';
export type StackCategory = 'frontend' | 'backend';

export const AGENT_IDS = ['developer', 'tester', 'security', 'peer-review', 'auditor'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const OPTIONAL_AGENTS = ['tester', 'security', 'peer-review', 'auditor'] as const;

/** Names given to the optional agents when the developer does not choose one. The developer agent uses the persona's name. */
export const DEFAULT_AGENT_NAMES: Record<(typeof OPTIONAL_AGENTS)[number], string> = {
  tester: 'Tara',
  security: 'Raksha',
  'peer-review': 'Mitra',
  auditor: 'Lekha'
};

export const AGENT_ROLES: Record<AgentId, string> = {
  developer: 'Developer',
  tester: 'Tester',
  security: 'Security reviewer',
  'peer-review': 'Peer reviewer',
  auditor: 'Auditor'
};
