import type { AgentActivity } from "./events.js";

/**
 * Events -> animation mapping. Deliberately conservative: we only claim what the event establishes.
 * Documented in ARCHITECTURE.md ("Events to animation mapping").
 */
const TEST_CMD =
  /\b(vitest|jest|pytest|mocha|playwright|cargo test|go test|dotnet test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test)\b/i;
const FFMPEG_CMD = /\b(ffmpeg|ffprobe|HandBrakeCLI)\b/i;

export function activityForTool(
  toolName: string | undefined,
  command?: string,
): { activity: AgentActivity; label: string } {
  const t = toolName ?? "";
  if (t === "Bash" || t === "PowerShell") {
    if (command && FFMPEG_CMD.test(command))
      return { activity: "rendering", label: "Running an ffmpeg/ffprobe command" };
    if (command && TEST_CMD.test(command)) return { activity: "testing", label: "Running a test command" };
    return { activity: "coding", label: "Running a shell command" };
  }
  if (["Read", "Grep", "Glob", "LS", "NotebookRead"].includes(t))
    return { activity: "reading", label: `${t}: reading files` };
  if (["WebSearch", "WebFetch"].includes(t))
    return { activity: "researching", label: `${t}: researching the web` };
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(t))
    return { activity: "coding", label: `${t}: changing a file` };
  if (t === "Task" || t === "Agent") return { activity: "meeting", label: "Delegating to a subagent" };
  if (t.startsWith("mcp__")) return { activity: "thinking", label: "Using an MCP tool" };
  return { activity: "thinking", label: t ? `Using tool ${t}` : "Working" };
}
