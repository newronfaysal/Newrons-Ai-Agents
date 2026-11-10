import type { EventInput } from "@ai-office/shared";
import type { Ingestor } from "./ingest.js";

interface Step {
  at: number; // ms from scenario start
  agent: string; // role id
  activity: string;
  type: EventInput["eventType"];
  status: EventInput["status"];
  summary: string;
  tool?: string;
}

/**
 * Scripted showcase. Every event is sourceType "demo": broadcast only, never persisted, and every
 * avatar it creates carries origin "demo" so the UI shows a SIMULATED badge. Nothing here talks to Claude.
 */
export const DEMO_SCENARIO: Step[] = [
  {
    at: 0,
    agent: "project-manager",
    activity: "meeting",
    type: "agent.state",
    status: "running",
    summary: "Reviewing the brief with the team",
  },
  {
    at: 500,
    agent: "research-analyst",
    activity: "meeting",
    type: "agent.state",
    status: "running",
    summary: "Joining the planning meeting",
  },
  {
    at: 1000,
    agent: "task-coordinator",
    activity: "meeting",
    type: "agent.state",
    status: "running",
    summary: "Breaking work into tasks",
  },
  {
    at: 4000,
    agent: "research-analyst",
    activity: "researching",
    type: "tool.pre",
    status: "running",
    summary: "WebSearch: researching reference reels",
    tool: "WebSearch",
  },
  {
    at: 6000,
    agent: "project-manager",
    activity: "coding",
    type: "agent.state",
    status: "running",
    summary: "Updating the whiteboard",
  },
  {
    at: 8000,
    agent: "script-writer",
    activity: "coding",
    type: "agent.state",
    status: "running",
    summary: "Writing hook and script",
  },
  {
    at: 10000,
    agent: "caption-specialist",
    activity: "reading",
    type: "agent.state",
    status: "running",
    summary: "Reading the transcript",
  },
  {
    at: 12000,
    agent: "video-editor",
    activity: "coding",
    type: "agent.state",
    status: "running",
    summary: "Cutting the timeline",
  },
  {
    at: 14000,
    agent: "frontend-dev",
    activity: "coding",
    type: "tool.pre",
    status: "running",
    summary: "Edit: changing a file (App.tsx)",
    tool: "Edit",
  },
  {
    at: 15000,
    agent: "backend-dev",
    activity: "coding",
    type: "tool.pre",
    status: "running",
    summary: "Edit: changing a file (server.ts)",
    tool: "Edit",
  },
  {
    at: 17000,
    agent: "code-reviewer",
    activity: "reading",
    type: "tool.pre",
    status: "running",
    summary: "Read: reading files",
    tool: "Read",
  },
  {
    at: 19000,
    agent: "video-editor",
    activity: "rendering",
    type: "tool.pre",
    status: "running",
    summary: "Running an ffmpeg/ffprobe command (simulated)",
    tool: "Bash",
  },
  {
    at: 21000,
    agent: "frontend-dev",
    activity: "testing",
    type: "tool.pre",
    status: "running",
    summary: "Running a test command (simulated)",
    tool: "Bash",
  },
  {
    at: 24000,
    agent: "backend-dev",
    activity: "error",
    type: "agent.state",
    status: "failed",
    summary: "A build failed (simulated)",
  },
  {
    at: 26000,
    agent: "backend-dev",
    activity: "coding",
    type: "agent.state",
    status: "running",
    summary: "Fixing the build",
  },
  {
    at: 28000,
    agent: "video-editor",
    activity: "finished",
    type: "agent.state",
    status: "finished",
    summary: "Export finished (simulated); sending to QA",
  },
  {
    at: 29000,
    agent: "content-reviewer",
    activity: "reading",
    type: "agent.state",
    status: "running",
    summary: "Reviewing the video deliverable",
  },
  {
    at: 31000,
    agent: "app-tester",
    activity: "testing",
    type: "agent.state",
    status: "running",
    summary: "Verifying acceptance criteria",
  },
  {
    at: 34000,
    agent: "issue-reporter",
    activity: "coding",
    type: "agent.state",
    status: "running",
    summary: "Writing a bug report",
  },
  {
    at: 36000,
    agent: "app-tester",
    activity: "needs_attention",
    type: "permission.request",
    status: "needs_attention",
    summary: "Waiting for a human decision (simulated)",
  },
  {
    at: 40000,
    agent: "project-manager",
    activity: "meeting",
    type: "agent.state",
    status: "running",
    summary: "Summarizing progress",
  },
  {
    at: 43000,
    agent: "project-manager",
    activity: "idle",
    type: "agent.state",
    status: "info",
    summary: "Demo scenario complete",
  },
];

export class DemoRunner {
  private timers: NodeJS.Timeout[] = [];
  running = false;
  constructor(
    private ingestor: Ingestor,
    private onState: () => void,
  ) {}

  /** speed > 1 plays faster (tests use a high value). */
  start(speed = 1, loop = true): void {
    this.stop(false);
    this.running = true;
    const total = Math.max(...DEMO_SCENARIO.map((s) => s.at)) / speed;
    for (const step of DEMO_SCENARIO) this.timers.push(setTimeout(() => this.emit(step), step.at / speed));
    if (loop)
      this.timers.push(setTimeout(() => this.running && this.start(speed, loop), total + 3000 / speed));
    this.onState();
  }

  emit(step: Step): void {
    this.ingestor.ingestEvent({
      sourceType: "demo",
      sessionId: "demo-session",
      agentId: `demo:${step.agent}`,
      eventType: step.type,
      status: step.status,
      summary: `[SIMULATED] ${step.summary}`,
      safeMetadata: {
        activity: step.activity,
        roleId: step.agent,
        ...(step.tool ? { tool: step.tool } : {}),
        demo: true,
      },
    });
  }

  stop(notify = true): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    const was = this.running;
    this.running = false;
    this.ingestor.registry.clearOrigin("demo");
    if (was || notify) this.onState();
  }
}
