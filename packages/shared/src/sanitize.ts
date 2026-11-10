const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|token|secret|passw(?:or)?d|authorization)\s*[=:]\s*)["']?[^\s"']{4,}/gi,
  /(--(?:api-key|token|password|secret)[= ])\S+/gi,
];

/** Redact credential-looking substrings and truncate. Applied server-side to every stored summary/metadata string. */
export function redact(input: string, max = 200): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, p1) =>
      typeof p1 === "string" && m.startsWith(p1) ? `${p1}[REDACTED]` : "[REDACTED]",
    );
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

const SENSITIVE_FILE =
  /(^|[\\/])(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials(\.json)?|.*secret.*|\.npmrc|\.netrc)$/i;

/** Reduce a path to its basename; sensitive-looking files are hidden entirely. */
export function safePathLabel(p: string): string {
  const base = p.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (SENSITIVE_FILE.test(p)) return "[sensitive file]";
  return base.slice(0, 80);
}
