import { z } from "zod";
import { DepartmentId } from "./departments.js";
import type { ProjectKind } from "./workflow.js";

/**
 * Task routing: deterministic, rule-based classification of user prompts and observed activity into departments.
 *
 * Design rules (see ROUTING.md):
 *  - Pure functions only. No I/O, no model calls. The same input always gives the same decision.
 *  - Intent-aware: a trigger word only counts when it is the action being requested, not when it appears in
 *    quoted text, code, a negation, a research/how-to question, or as the object of another action
 *    ("Develop an app to edit videos" is development, not video editing).
 *  - When nothing clearly matches, the request stays with Planning. We never activate every department.
 */

// ---------------------------------------------------------------- department state machine

export const DepartmentState = z.enum([
  "available",
  "planning",
  "assigned",
  "working",
  "waiting",
  "testing",
  "reviewing",
  "blocked",
  "completed",
  "error",
  "offline",
]);
export type DepartmentState = z.infer<typeof DepartmentState>;

export const DepartmentStatus = z.object({
  departmentId: DepartmentId,
  state: DepartmentState,
  /** Human-readable reason, always grounded in an observed event or a router decision. */
  reason: z.string().max(300),
  /** Planning only: monitoring = ready for prompts, active = processing/doing real planning work, idle = nothing. */
  mode: z.enum(["monitoring", "active", "idle"]).nullable(),
  workItemIds: z.array(z.string()).max(50),
  openCount: z.number().int(),
  since: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  /** true when the state came from an activity that has gone silent (no events for the inactivity timeout). */
  stale: z.boolean(),
});
export type DepartmentStatus = z.infer<typeof DepartmentStatus>;

// ---------------------------------------------------------------- rules + settings

export const RuleTrigger = z.enum(["prompt", "activity"]);
export type RuleTrigger = z.infer<typeof RuleTrigger>;
export const ActivityKind = z.enum(["test-command", "media-command", "verification-command"]);
export type ActivityKind = z.infer<typeof ActivityKind>;

export const RuleConditions = z.object({
  /** activity rules: which kind of operation this rule detects. */
  activity: ActivityKind.optional(),
  /** activity rules: "always", or only when the current task/project already involves this department. */
  scope: z.enum(["always", "task-or-project"]).default("always"),
});
export const RuleAction = z.object({
  /** assign = the department receives the work; suggest = shown in the decision but not assigned. */
  mode: z.enum(["assign", "suggest"]).default("assign"),
  /** Departments that must follow this one (e.g. QA after a bug fix). */
  followUp: z.array(DepartmentId).max(4).default([]),
});

const word = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((s) => s.toLowerCase());

export const RoutingRuleInput = z.object({
  id: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, - and _ only"),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).default(""),
  departmentId: DepartmentId,
  triggerType: RuleTrigger,
  /** prompt rules: action verbs/phrases ("develop", "fix bug"). activity rules: regular expressions matched against the command. */
  keywords: z.array(word).max(80),
  /** prompt rules: object nouns that qualify a generic verb ("create" + "subtitles"). Unused for activity rules. */
  contextWords: z.array(word).max(80).default([]),
  priority: z.number().int().min(0).max(100).default(50),
  enabled: z.boolean().default(true),
  conditions: RuleConditions.default({ scope: "always" }),
  action: RuleAction.default({ mode: "assign", followUp: [] }),
});
export type RoutingRuleInput = z.input<typeof RoutingRuleInput>;

export const RoutingRule = RoutingRuleInput.extend({
  builtin: z.boolean().default(false),
  lastTriggeredAt: z.string().nullable().default(null),
  lastSourceEventId: z.string().nullable().default(null),
});
export type RoutingRule = z.infer<typeof RoutingRule>;

export const RoutingSettings = z.object({
  /** automatic = departments are assigned immediately; approval = assignments wait for your approval. */
  assignmentMode: z.enum(["automatic", "approval"]).default("automatic"),
  /** Classify prompt text (in memory only; never stored). Off = every prompt stays with Planning. */
  promptClassification: z.boolean().default(true),
  /** Activate QA when a real test/verification command is observed, even if the prompt did not ask for it. */
  qaAutoDetect: z.boolean().default(true),
  /** Tie-breaker when two rules match equally well. */
  departmentPriority: z.array(DepartmentId).length(4).default(["dev", "video", "qa", "planning"]),
  /** Departments switched off for automation; shown as "offline". */
  disabledDepartments: z.array(DepartmentId).max(3).default([]),
  /** A working/testing department with no events for this long is shown as waiting (state unknown). */
  inactivityMs: z.number().int().min(15_000).max(3_600_000).default(120_000),
  /** A mid-turn task with no events for this long is marked "unknown" (never "completed"). */
  itemTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(30 * 60_000),
  /** How long Planning shows "planning" after classifying a prompt. */
  planningPulseMs: z.number().int().min(1000).max(60_000).default(8000),
  /** How long completed/failed results stay visible on a department. */
  resultLingerMs: z.number().int().min(5000).max(3_600_000).default(90_000),
  /** Clause leads that make a clause a question/research request (topic words are not actions). */
  inquiryWords: z
    .array(word)
    .max(100)
    .default([
      "research",
      "investigate",
      "explain",
      "describe",
      "summarize",
      "summarise",
      "compare",
      "learn",
      "study",
      "brainstorm",
      "discuss",
      "tell",
      "list",
      "find",
      "search",
      "look",
      "what",
      "what's",
      "why",
      "how",
      "who",
      "when",
      "where",
      "which",
      "is",
      "are",
      "does",
      "should",
      "can",
      "could",
      "would",
      "translate",
      "proofread",
    ]),
  /** Topic markers anywhere in a clause that make it planning/strategy work. */
  inquiryMarkers: z
    .array(word)
    .max(100)
    .default([
      "how to",
      "how do",
      "how can",
      "how should",
      "ways to",
      "ideas",
      "idea",
      "strategy",
      "strategies",
      "trends",
      "market",
      "roadmap",
      "proposal",
      "best practices",
      "pros and cons",
      "plan",
      "competitors",
    ]),
  /** Verbs that request work but do not by themselves say which department (resolved by their object). */
  genericVerbs: z
    .array(word)
    .max(100)
    .default([
      "create",
      "make",
      "add",
      "write",
      "update",
      "change",
      "modify",
      "improve",
      "generate",
      "produce",
      "prepare",
      "set",
      "setup",
      "run",
      "start",
      "do",
      "fix",
      "edit",
      "finish",
      "complete",
      "redo",
      "rework",
      "adjust",
      "export",
      "put",
      "design",
      "remove",
      "delete",
      "rename",
      "convert",
    ]),
  /** Polite/lead-in phrases stripped before finding the action verb. */
  politePrefixes: z
    .array(word)
    .max(100)
    .default([
      "please",
      "pls",
      "kindly",
      "can you",
      "could you",
      "would you",
      "will you",
      "can we",
      "could we",
      "i want you to",
      "i need you to",
      "i'd like you to",
      "i would like you to",
      "i want to",
      "i need to",
      "we need to",
      "we should",
      "let's",
      "lets",
      "let us",
      "help me",
      "help me to",
      "go ahead and",
      "now",
      "also",
      "then",
      "first",
      "next",
      "finally",
      "quickly",
      "just",
      "ok",
      "okay",
      "and",
    ]),
});
export type RoutingSettings = z.infer<typeof RoutingSettings>;
export const DEFAULT_ROUTING_SETTINGS: RoutingSettings = RoutingSettings.parse({});

export const DEFAULT_RULES: RoutingRule[] = [
  {
    id: "dev-build",
    name: "Software development",
    description: "Building, implementing or changing software.",
    departmentId: "dev",
    triggerType: "prompt",
    keywords: [
      "develop",
      "build",
      "code",
      "implement",
      "refactor",
      "program",
      "create app",
      "make app",
      "build app",
      "scaffold",
      "deploy script",
    ],
    contextWords: [
      "app",
      "application",
      "software",
      "development",
      "coding",
      "programming",
      "frontend",
      "front-end",
      "backend",
      "back-end",
      "website",
      "web app",
      "api",
      "endpoint",
      "feature",
      "dashboard",
      "component",
      "database",
      "schema",
      "function",
      "module",
      "class",
      "script",
      "cli",
      "server",
      "page",
      "ui",
      "plugin",
      "extension",
      "bot",
      "codebase",
      "code",
      "login",
      "migration",
    ],
    priority: 60,
    enabled: true,
    conditions: { scope: "always" },
    action: { mode: "assign", followUp: [] },
    builtin: true,
    lastTriggeredAt: null,
    lastSourceEventId: null,
  },
  {
    id: "dev-bugfix",
    name: "Bug fixing and debugging",
    description: "Debugging and bug fixes. Fixed work must be verified, so QA follows.",
    departmentId: "dev",
    triggerType: "prompt",
    keywords: [
      "debug",
      "fix bug",
      "fix error",
      "fix issue",
      "fix crash",
      "fix failing",
      "fix exception",
      "fix regression",
      "troubleshoot",
    ],
    contextWords: ["bug", "error", "crash", "exception", "regression", "stack trace"],
    priority: 70,
    enabled: true,
    conditions: { scope: "always" },
    action: { mode: "assign", followUp: ["qa"] },
    builtin: true,
    lastTriggeredAt: null,
    lastSourceEventId: null,
  },
  {
    id: "video-edit",
    name: "Video editing and production",
    description: "Editing, captioning, rendering or exporting video. Ideas and strategy stay with Planning.",
    departmentId: "video",
    triggerType: "prompt",
    keywords: [
      "edit video",
      "edit reel",
      "edit footage",
      "edit clip",
      "cut video",
      "cut clip",
      "cut footage",
      "trim footage",
      "trim video",
      "trim clip",
      "trim seconds",
      "trim intro",
      "trim outro",
      "render video",
      "render reel",
      "render clip",
      "export video",
      "export reel",
      "create short video",
      "create reel",
      "make reel",
      "make video",
      "add captions",
      "add subtitles",
      "add transition",
      "caption",
      "subtitle",
      "transcode",
      "color grade",
      "colour grade",
    ],
    contextWords: [
      "video",
      "reel",
      "footage",
      "clip",
      "short video",
      "shorts",
      "subtitles",
      "captions",
      "b-roll",
      "montage",
      "thumbnail",
      "transition",
      "timeline",
      "voiceover",
      "intro",
      "outro",
      "ffmpeg",
    ],
    priority: 60,
    enabled: true,
    conditions: { scope: "always" },
    action: { mode: "assign", followUp: [] },
    builtin: true,
    lastTriggeredAt: null,
    lastSourceEventId: null,
  },
  {
    id: "qa-verify",
    name: "Testing and verification",
    description: "Explicit requests to test, verify, validate or review output.",
    departmentId: "qa",
    triggerType: "prompt",
    keywords: [
      "test",
      "run test",
      "verify",
      "validate",
      "qa",
      "quality check",
      "review output",
      "check bug",
      "check for bug",
      "check subtitle",
      "check output",
    ],
    contextWords: ["tests", "unit tests", "test suite", "testing", "e2e", "qa", "verification", "validation"],
    priority: 55,
    enabled: true,
    conditions: { scope: "always" },
    action: { mode: "assign", followUp: [] },
    builtin: true,
    lastTriggeredAt: null,
    lastSourceEventId: null,
  },
  {
    id: "act-qa-test-runner",
    name: "Observed test run",
    description: "A real test runner command was executed (QA auto-detection).",
    departmentId: "qa",
    triggerType: "activity",
    keywords: [
      "\\b(vitest|jest|pytest|mocha|playwright|cypress|phpunit|rspec|ctest|tox|nox)\\b",
      "\\b(cargo|go|dotnet|deno|bun)\\s+test\\b",
      "\\b(npm|pnpm|yarn)\\s+(run\\s+)?(test|e2e)\\b",
      "\\bnpx\\s+(vitest|jest|playwright|cypress)\\b",
      "\\bpython\\s+-m\\s+(pytest|unittest)\\b",
    ],
    contextWords: [],
    priority: 80,
    enabled: true,
    conditions: { activity: "test-command", scope: "always" },
    action: { mode: "assign", followUp: [] },
    builtin: true,
    lastTriggeredAt: null,
    lastSourceEventId: null,
  },
  {
    id: "act-qa-media-check",
    name: "Observed media / subtitle verification",
    description:
      "ffprobe or subtitle validation commands. Off by default because ffprobe is also used while editing.",
    departmentId: "qa",
    triggerType: "activity",
    keywords: ["\\bffprobe\\b", "\\b(srt|vtt|subtitle)s?[-_ ]?(lint|valid\\w*|check)\\b"],
    contextWords: [],
    priority: 70,
    enabled: false,
    conditions: { activity: "verification-command", scope: "always" },
    action: { mode: "assign", followUp: [] },
    builtin: true,
    lastTriggeredAt: null,
    lastSourceEventId: null,
  },
  {
    id: "act-video-media",
    name: "Observed render / media command",
    description: "ffmpeg-style commands, counted as Video Editor work when the task or project is video.",
    departmentId: "video",
    triggerType: "activity",
    keywords: ["\\bffmpeg\\b", "\\bHandBrakeCLI\\b", "\\bmelt\\b", "\\bauto-editor\\b"],
    contextWords: [],
    priority: 60,
    enabled: true,
    conditions: { activity: "media-command", scope: "task-or-project" },
    action: { mode: "assign", followUp: [] },
    builtin: true,
    lastTriggeredAt: null,
    lastSourceEventId: null,
  },
];

// ---------------------------------------------------------------- decisions

export type MatchHow =
  "explicit" | "lead-phrase" | "lead-verb" | "verb+object" | "project-context" | "follow-up" | "continuation";

export interface RouteMatch {
  ruleId: string | null;
  departmentId: DepartmentId;
  /** The rule keyword that matched (a rule word, never raw prompt text). */
  keyword: string;
  how: MatchHow;
  clause: number;
}
export interface SuppressedMatch {
  ruleId: string | null;
  departmentId: DepartmentId;
  keyword: string;
  reason: string;
}
export interface RouteStage {
  departmentId: DepartmentId;
  role: "coordinator" | "producer" | "verifier";
  reason: string;
  ruleId: string | null;
}
export type PromptIntent = "work" | "inquiry" | "unclear" | "continuation" | "empty" | "unavailable";
export interface RoutingDecision {
  intent: PromptIntent;
  /** Always starts with "planning". Ordered: planning → producers (prompt order) → qa. */
  departments: DepartmentId[];
  stages: RouteStage[];
  matches: RouteMatch[];
  suppressed: SuppressedMatch[];
  suggestions: RouteMatch[];
  explicit: boolean;
  /** Multi-department or long requests. A Planning Agent could help, but only if execution is configured. */
  complex: boolean;
  explanation: string;
}

export interface ClassifyContext {
  projectKind?: ProjectKind | null;
}

const DEPT_NAME: Record<DepartmentId, string> = {
  planning: "Planning",
  dev: "App Development",
  video: "Video Editor",
  qa: "QA",
};
export const departmentName = (d: DepartmentId) => DEPT_NAME[d];

// ---------------------------------------------------------------- text helpers

const QUOTE_PLACEHOLDER = " quotedtext ";

/** Remove text the user is quoting or showing rather than asking for: code, quotes, block quotes. */
export function stripNonInstructions(text: string): { clean: string; removed: string[] } {
  const removed: string[] = [];
  const take = (m: string) => {
    removed.push(m);
    return QUOTE_PLACEHOLDER;
  };
  let t = text.replace(/```[\s\S]*?(```|$)/g, take);
  t = t.replace(/`[^`\n]*`/g, take);
  t = t
    .split(/\r?\n/)
    .map((l) => (/^\s*>/.test(l) ? take(l) : l))
    .join("\n");
  t = t.replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|„[^“”\n]*[“”]/g, take);
  // single quotes only when they clearly wrap a phrase (avoid apostrophes like "let's")
  t = t.replace(/(^|[\s(:])'([^'\n]*\s[^'\n]*)'(?=[\s).,;:!?]|$)/g, (m, pre: string) => pre + take(m));
  return { clean: t, removed };
}

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9][a-z0-9'+#-]*/g) ?? [];

function inflects(token: string, w: string): boolean {
  if (token === w) return true;
  if (!token.startsWith(w.slice(0, Math.max(1, w.length - 2)))) return false;
  const forms = [w + "s", w + "es", w + "ed", w + "d", w + "ing"];
  if (w.endsWith("e")) forms.push(w.slice(0, -1) + "ing", w.slice(0, -1) + "ed");
  if (w.endsWith("y")) forms.push(w.slice(0, -1) + "ies", w.slice(0, -1) + "ied");
  const last = w.at(-1)!;
  if (/[bdgmnprt]/.test(last)) forms.push(w + last + "ing", w + last + "ed");
  return forms.includes(token);
}

/**
 * Match a keyword phrase starting at `start`. Later words of the phrase may be separated by up to `gap`
 * tokens ("fix bug" matches "fix the login bug"). Returns the index after the match or -1.
 */
export function matchPhraseAt(tokens: string[], phrase: string[], start: number, gap = 3): number {
  if (!phrase.length || start >= tokens.length || !inflects(tokens[start]!, phrase[0]!)) return -1;
  let pos = start + 1;
  for (let k = 1; k < phrase.length; k++) {
    let found = -1;
    for (let j = pos; j < Math.min(tokens.length, pos + gap + 1); j++) {
      if (BOUNDARY.has(tokens[j]!) && j > pos) break;
      if (inflects(tokens[j]!, phrase[k]!)) {
        found = j;
        break;
      }
    }
    if (found < 0) return -1;
    pos = found + 1;
  }
  return pos;
}

/** Words that end the object of a verb: what follows is purpose/description, not a second action. */
const BOUNDARY = new Set([
  "to",
  "for",
  "that",
  "which",
  "who",
  "so",
  "where",
  "because",
  "using",
  "with",
  "about",
  "like",
  "via",
  "from",
  "into",
  "by",
  "quotedtext",
]);
const NEGATIONS = new Set(["don't", "dont", "never", "not", "avoid", "without", "no", "stop"]);
const CONTINUATION =
  /^(continue|keep going|go on|proceed|carry on|resume|yes|yep|yeah|ok|okay|sure|do it|go ahead|sounds good|looks good|lgtm|please continue|try again|retry|again)[\s.!]*$/i;
const WH_COMPLEMENT = /\b(how (to|do|does|did|can|could|should|would|is|are)|what|why|ways to|whether)\b/;

const EXPLICIT_DEPT: [RegExp, DepartmentId][] = [
  [/^(planning|plan|research)$/, "planning"],
  [/^(dev|development|app|app development|developer|developers|engineering|coding)$/, "dev"],
  [/^(video|video editor|video editing|editor|editing|media)$/, "video"],
  [/^(qa|quality|quality assurance|test|testing|testers|verification)$/, "qa"],
];
const deptFromWord = (w: string): DepartmentId | null =>
  EXPLICIT_DEPT.find(([re]) => re.test(w.trim().toLowerCase()))?.[1] ?? null;

interface Explicit {
  include: DepartmentId[];
  exclude: DepartmentId[];
  only: boolean;
}
function explicitDirectives(clean: string): Explicit {
  const out: Explicit = { include: [], exclude: [], only: false };
  const low = clean.toLowerCase();
  for (const m of low.matchAll(/(^|\s)@([a-z-]+)/g)) {
    const d = deptFromWord(m[2]!.replace(/-/g, " "));
    if (d) out.include.push(d);
  }
  for (const m of low.matchAll(
    /\b(?:assign|send|route|give|hand|delegate)\s+(?:this|it|that)?\s*(?:over\s+)?to\s+(?:the\s+)?(planning|app development|development|dev|video editor|video editing|video|qa|testing|quality assurance)(?:\s+(?:team|department|dept))?\b/g,
  )) {
    const d = deptFromWord(m[1]!);
    if (d) out.include.push(d);
  }
  if (
    /\b(planning|research|plan) only\b|\bonly (plan|planning|research)\b|\bdon'?t (build|code|implement|edit|render) anything\b/.test(
      low,
    )
  )
    out.only = true;
  for (const m of low.matchAll(
    /\b(?:no|skip|without|don'?t)\s+(?:run(?:ning)?\s+)?(?:the\s+)?(qa|tests?|testing|verification)\b/g,
  )) {
    const d = deptFromWord(m[1]!.replace(/s$/, ""));
    if (d) out.exclude.push(d);
  }
  return out;
}

function splitSentences(clean: string): string[] {
  return clean
    .split(/[.;!?]+(?=\s|$)|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function splitClauses(sentence: string): { text: string; resetsCarry: boolean }[] {
  const parts = sentence.split(
    /\s*(,|\band then\b|\bthen\b|\band also\b|\bafter that\b|\bafterwards\b|\band\b|\bplus\b)\s*/i,
  );
  const out: { text: string; resetsCarry: boolean }[] = [];
  let reset = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (i % 2 === 1) {
      reset = /then|after/i.test(p);
      continue;
    }
    if (p.trim()) out.push({ text: p.trim(), resetsCarry: reset });
    reset = false;
  }
  return out;
}

function stripPrefixes(tokens: string[], prefixes: string[][]): string[] {
  let t = tokens;
  for (let guard = 0; guard < 8; guard++) {
    const p = prefixes.find((pre) => pre.length <= t.length && pre.every((w, i) => t[i] === w));
    if (!p) break;
    t = t.slice(p.length);
  }
  return t;
}

const phraseWords = (s: string) => tokenize(s);
const containsPhrase = (tokens: string[], phrase: string[]) => {
  for (let i = 0; i < tokens.length; i++) if (matchPhraseAt(tokens, phrase, i, 0) >= 0) return true;
  return false;
};

interface Candidate {
  rule: RoutingRule;
  keyword: string;
  how: MatchHow;
  pos: number;
  specificity: number;
}

function better(a: Candidate, b: Candidate | null, prio: DepartmentId[]): boolean {
  if (!b) return true;
  if (a.pos !== b.pos) return a.pos < b.pos;
  if (a.specificity !== b.specificity) return a.specificity > b.specificity;
  if (a.rule.priority !== b.rule.priority) return a.rule.priority > b.rule.priority;
  return prio.indexOf(a.rule.departmentId) < prio.indexOf(b.rule.departmentId);
}

/** Every rule keyword/context word occurring anywhere in the tokens (for explaining suppressions). */
function allHits(tokens: string[], rules: RoutingRule[]): { rule: RoutingRule; keyword: string }[] {
  const hits: { rule: RoutingRule; keyword: string }[] = [];
  for (const r of rules)
    for (const kw of [...r.keywords, ...r.contextWords]) {
      const pw = phraseWords(kw);
      for (let i = 0; i < tokens.length; i++)
        if (matchPhraseAt(tokens, pw, i) >= 0) {
          hits.push({ rule: r, keyword: kw });
          break;
        }
    }
  return hits;
}

/**
 * Classify one prompt. Deterministic and side-effect free; used both for live routing and the "Test prompt" tool.
 */
export function classifyPrompt(
  text: string,
  allRules: RoutingRule[],
  settings: RoutingSettings = DEFAULT_ROUTING_SETTINGS,
  ctx: ClassifyContext = {},
): RoutingDecision {
  const rules = allRules.filter((r) => r.enabled && r.triggerType === "prompt");
  const prio = settings.departmentPriority;
  const matches: RouteMatch[] = [];
  const suppressed: SuppressedMatch[] = [];
  const suggestions: RouteMatch[] = [];
  const base = (intent: PromptIntent, explanation: string): RoutingDecision => ({
    intent,
    departments: ["planning"],
    stages: [
      { departmentId: "planning", role: "coordinator", reason: "Coordinates every request", ruleId: null },
    ],
    matches,
    suppressed,
    suggestions,
    explicit: false,
    complex: false,
    explanation,
  });
  if (!text.trim()) return base("empty", "Empty prompt: Planning keeps it.");
  if (CONTINUATION.test(text.trim()))
    return base("continuation", "Continuation of the current task: Planning keeps the existing assignment.");

  const { clean, removed } = stripNonInstructions(text);
  for (const seg of removed)
    for (const h of allHits(tokenize(seg), rules))
      suppressed.push({
        ruleId: h.rule.id,
        departmentId: h.rule.departmentId,
        keyword: h.keyword,
        reason: "inside quoted text or code",
      });

  const prefixes = settings.politePrefixes.map(phraseWords).sort((a, b) => b.length - a.length);
  const inquiryLeads = new Set(settings.inquiryWords);
  const inquiryMarkers = settings.inquiryMarkers.map(phraseWords);
  const generic = new Set(settings.genericVerbs);

  let sawWork = false;
  let sawInquiry = false;
  let clauseNo = 0;
  for (const sentence of splitSentences(clean)) {
    let carryInquiry = false;
    for (const clause of splitClauses(sentence)) {
      if (clause.resetsCarry) carryInquiry = false;
      const idx = clauseNo++;
      const raw = tokenize(clause.text);
      const tokens = stripPrefixes(raw, prefixes);
      if (!tokens.length) continue;
      const lead = tokens[0]!;
      const hits = allHits(tokens, rules);
      const suppressAll = (reason: string) => {
        for (const h of hits)
          suppressed.push({
            ruleId: h.rule.id,
            departmentId: h.rule.departmentId,
            keyword: h.keyword,
            reason,
          });
      };
      if (NEGATIONS.has(lead) || (lead === "do" && tokens[1] === "not")) {
        suppressAll("negated (the request says not to do it)");
        continue;
      }
      const wh = WH_COMPLEMENT.test(tokens.join(" "));
      const leadIsAction = rules.some((r) =>
        r.keywords.some((k) => matchPhraseAt(tokens, phraseWords(k), 0) >= 0),
      );
      // A clause that starts with a department action ("Build a market dashboard") is only a question when it
      // carries a wh-complement; any other clause becomes planning work when it mentions a planning topic.
      const hasMarker = inquiryMarkers.some((m) => containsPhrase(tokens, m));
      const inquiry = carryInquiry || inquiryLeads.has(lead) || (hasMarker && (!leadIsAction || wh));
      if (inquiry) {
        sawInquiry = true;
        if (wh) carryInquiry = true;
        suppressAll("topic of a research, planning or how-to request, not a request to do the work");
        continue;
      }
      // 1) the clause starts with a department action keyword (most specific phrase wins)
      let best: Candidate | null = null;
      for (const r of rules)
        for (const kw of r.keywords) {
          const pw = phraseWords(kw);
          if (matchPhraseAt(tokens, pw, 0) >= 0) {
            const c: Candidate = {
              rule: r,
              keyword: kw,
              how: pw.length > 1 ? "lead-phrase" : "lead-verb",
              pos: 0,
              specificity: pw.length,
            };
            if (better(c, best, prio)) best = c;
          }
        }
      // 2) a generic verb ("create", "run", "fix") resolved by its object, up to the first boundary word
      if (!best && generic.has(lead)) {
        sawWork = true;
        for (let i = 1; i < tokens.length && !best; i++) {
          if (BOUNDARY.has(tokens[i]!)) break;
          let here: Candidate | null = null;
          for (const r of rules)
            for (const kw of [...r.contextWords, ...r.keywords]) {
              const pw = phraseWords(kw);
              if (matchPhraseAt(tokens, pw, i, 0) >= 0) {
                const c: Candidate = {
                  rule: r,
                  keyword: kw,
                  how: "verb+object",
                  pos: i,
                  specificity: pw.length,
                };
                if (better(c, here, prio)) here = c;
              }
            }
          best = here;
        }
      }
      if (!best) {
        if (hits.length) suppressAll("not the requested action in this sentence");
        continue;
      }
      sawWork = true;
      const m: RouteMatch = {
        ruleId: best.rule.id,
        departmentId: best.rule.departmentId,
        keyword: best.keyword,
        how: best.how,
        clause: idx,
      };
      if (best.rule.action.mode === "suggest") suggestions.push(m);
      else matches.push(m);
      for (const h of hits)
        if (h.rule.departmentId !== best.rule.departmentId)
          suppressed.push({
            ruleId: h.rule.id,
            departmentId: h.rule.departmentId,
            keyword: h.keyword,
            reason: `describes the object of "${best.keyword}", not a separate request`,
          });
    }
  }

  const ex = explicitDirectives(clean);
  let explicit = false;
  let producers: { d: DepartmentId; reason: string; ruleId: string | null; role: RouteStage["role"] }[] = [];
  if (ex.only) {
    explicit = true;
    for (const m of matches)
      suppressed.push({
        ruleId: m.ruleId,
        departmentId: m.departmentId,
        keyword: m.keyword,
        reason: "you asked for planning only",
      });
    matches.length = 0;
  } else if (ex.include.length) {
    explicit = true;
    for (const d of ex.include)
      if (d !== "planning") {
        matches.push({ ruleId: null, departmentId: d, keyword: `@${d}`, how: "explicit", clause: -1 });
      }
    // explicit assignment overrides inferred departments
    for (const m of [...matches])
      if (m.how !== "explicit" && !ex.include.includes(m.departmentId)) {
        suppressed.push({
          ruleId: m.ruleId,
          departmentId: m.departmentId,
          keyword: m.keyword,
          reason: "overridden by your explicit assignment",
        });
        matches.splice(matches.indexOf(m), 1);
      }
  }
  for (const m of matches) {
    if (producers.some((p) => p.d === m.departmentId)) continue;
    producers.push({
      d: m.departmentId,
      reason: m.how === "explicit" ? "You assigned it explicitly" : `"${m.keyword}" (${m.how})`,
      ruleId: m.ruleId,
      role: m.departmentId === "qa" ? "verifier" : "producer",
    });
    const rule = rules.find((r) => r.id === m.ruleId);
    for (const f of rule?.action.followUp ?? [])
      if (!producers.some((p) => p.d === f) && f !== "planning")
        producers.push({
          d: f,
          reason: `Follow-up required by rule "${rule!.name}"`,
          ruleId: rule!.id,
          role: f === "qa" ? "verifier" : "producer",
        });
  }

  // Project context: a work request with no department-specific words inherits the project's department.
  if (!producers.length && sawWork && !ex.only && ctx.projectKind && ctx.projectKind !== "general") {
    const d: DepartmentId = ctx.projectKind === "video" ? "video" : "dev";
    producers.push({
      d,
      reason: `Work request in a ${ctx.projectKind} project`,
      ruleId: null,
      role: "producer",
    });
    matches.push({
      ruleId: null,
      departmentId: d,
      keyword: `${ctx.projectKind} project`,
      how: "project-context",
      clause: -1,
    });
  }

  for (const d of ex.exclude)
    producers = producers.filter((p) => {
      if (p.d !== d) return true;
      suppressed.push({ ruleId: p.ruleId, departmentId: d, keyword: d, reason: "you asked to skip it" });
      return false;
    });
  producers = producers.filter((p) => {
    if (!settings.disabledDepartments.includes(p.d)) return true;
    suppressed.push({
      ruleId: p.ruleId,
      departmentId: p.d,
      keyword: p.d,
      reason: "department is switched off in automation settings",
    });
    return false;
  });
  // QA always runs after the producing departments.
  producers.sort((a, b) => Number(a.d === "qa") - Number(b.d === "qa"));

  const stages: RouteStage[] = [
    { departmentId: "planning", role: "coordinator", reason: "Coordinates every request", ruleId: null },
    ...producers
      .filter((p) => p.d !== "planning")
      .map((p) => ({ departmentId: p.d, role: p.role, reason: p.reason, ruleId: p.ruleId })),
  ];
  const departments = stages.map((s) => s.departmentId);
  const intent: PromptIntent =
    departments.length > 1 ? "work" : sawInquiry && !sawWork ? "inquiry" : "unclear";
  const explanation =
    departments.length > 1
      ? `Planning → ${departments.slice(1).map(departmentName).join(" → ")}`
      : intent === "inquiry"
        ? "Research/planning request: Planning handles it."
        : ex.only
          ? "You asked for planning only."
          : "No clear department: Planning keeps it.";
  return {
    intent,
    departments,
    stages,
    matches,
    suppressed,
    suggestions,
    explicit,
    complex: departments.length >= 4 || text.length > 1500,
    explanation,
  };
}

// ---------------------------------------------------------------- observed activity

export interface ActivityRouting {
  kind: ActivityKind | "work";
  /** Department the operation belongs to; null = the current task's primary department. */
  departmentId: DepartmentId | null;
  ruleId: string | null;
  scope: "always" | "task-or-project";
}

const regexCache = new Map<string, RegExp | null>();
export function safeRegex(src: string): RegExp | null {
  if (regexCache.has(src)) return regexCache.get(src)!;
  let re: RegExp | null = null;
  try {
    if (src.length <= 300) re = new RegExp(src, "i");
  } catch {
    re = null;
  }
  regexCache.set(src, re);
  return re;
}

/** Classify a real tool operation (command text is used transiently and never stored). */
export function classifyActivity(
  toolName: string | null | undefined,
  command: string | null | undefined,
  allRules: RoutingRule[],
  settings: RoutingSettings = DEFAULT_ROUTING_SETTINGS,
): ActivityRouting {
  const none: ActivityRouting = { kind: "work", departmentId: null, ruleId: null, scope: "always" };
  if (!command || !(toolName === "Bash" || toolName === "PowerShell")) return none;
  const rules = allRules
    .filter((r) => r.enabled && r.triggerType === "activity" && r.conditions.activity)
    .sort((a, b) => b.priority - a.priority);
  for (const r of rules) {
    if (r.departmentId === "qa" && !settings.qaAutoDetect) continue;
    if (settings.disabledDepartments.includes(r.departmentId)) continue;
    if (r.keywords.some((k) => safeRegex(k)?.test(command)))
      return {
        kind: r.conditions.activity!,
        departmentId: r.departmentId,
        ruleId: r.id,
        scope: r.conditions.scope,
      };
  }
  return none;
}
