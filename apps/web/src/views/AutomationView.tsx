import { useEffect, useMemo, useState } from "react";
import {
  DEPARTMENTS,
  departmentName,
  type DepartmentId,
  type RoutingDecision,
  type RoutingRule,
  type RoutingSettings,
} from "@ai-office/shared";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { ago } from "../lib/format";
import {
  useRefreshRouting,
  useRoutingLog,
  useRoutingRules,
  useRoutingSettings,
  useWorkItems,
  type WorkItem,
} from "../lib/queries";
import { DepartmentCard, StateBadge } from "../components/TeamStatus";

const DEPT_IDS = DEPARTMENTS.map((d) => d.id);
const STATUS_TEXT: Record<string, string> = {
  planning: "Planning",
  pending_approval: "Awaiting your approval",
  assigned: "Assigned",
  in_progress: "In progress",
  testing: "Testing",
  blocked: "Blocked",
  revision: "Revision (returned by QA)",
  awaiting_verification: "Awaiting verification",
  waiting: "Waiting",
  error: "Error",
  completed: "Completed",
  accepted: "Accepted by you",
  interrupted: "Interrupted",
  unknown: "Unknown (went silent)",
  superseded: "Superseded",
  cancelled: "Cancelled",
};
const BAD = new Set(["error", "interrupted", "revision", "blocked", "unknown"]);
const GOOD = new Set(["completed", "accepted"]);

function useAct() {
  const toast = useStore((s) => s.toast);
  const refresh = useRefreshRouting();
  return async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      refresh();
      if (ok) toast("success", ok);
      return true;
    } catch (e) {
      toast("error", (e as Error).message);
      return false;
    }
  };
}

function Section({ title, children, help }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <section className="panel space-y-3 p-4" aria-label={title}>
      <div>
        <h3 className="font-semibold">{title}</h3>
        {help ? <p className="muted text-sm">{help}</p> : null}
      </div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ test prompt

function TestPrompt() {
  const [text, setText] = useState("Develop an application and run tests");
  const [kind, setKind] = useState<"" | "app" | "video" | "general">("");
  const [res, setRes] = useState<RoutingDecision | null>(null);
  const toast = useStore((s) => s.toast);
  const run = async () => {
    try {
      setRes(
        await api<RoutingDecision>("POST", "/api/routing/test", { prompt: text, projectKind: kind || null }),
      );
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  return (
    <Section
      title="Test a prompt"
      help="See which departments would activate. This is a dry run: nothing is executed, assigned or stored."
    >
      <textarea
        className="input min-h-[70px] w-full"
        aria-label="Prompt to test"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void run();
        }}
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5">
          Project type
          <select
            className="input"
            style={{ width: "auto" }}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="">none</option>
            <option value="app">app</option>
            <option value="video">video</option>
            <option value="general">general</option>
          </select>
        </label>
        <button className="btn btn-primary" onClick={() => void run()} data-testid="test-prompt-run">
          Test routing
        </button>
        <span className="muted text-xs">Ctrl+Enter</span>
      </div>
      {res && (
        <div className="panel2 space-y-2 p-3 text-sm" data-testid="test-prompt-result">
          <div className="flex flex-wrap items-center gap-1.5">
            {res.departments.map((d, i) => (
              <span key={d} className="flex items-center gap-1.5">
                {i > 0 && <span className="muted">→</span>}
                <span className="badge">{departmentName(d)}</span>
              </span>
            ))}
            <span className="muted ml-2">intent: {res.intent}</span>
            {res.explicit && <span className="badge">explicit instruction</span>}
          </div>
          <div>{res.explanation}</div>
          {res.complex && (
            <div className="muted text-xs">
              Complex request. A Planning Agent would help, but no supported execution method is configured,
              so it is routed by rules only.
            </div>
          )}
          {res.matches.length > 0 && (
            <div>
              <div className="font-medium">Why</div>
              <ul className="ml-4 list-disc">
                {res.matches.map((m, i) => (
                  <li key={i}>
                    {departmentName(m.departmentId)}: “{m.keyword}” ({m.how.replace("+", " + ")})
                    {m.ruleId ? <span className="muted"> · rule {m.ruleId}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {res.suppressed.length > 0 && (
            <div>
              <div className="font-medium">Trigger words ignored</div>
              <ul className="ml-4 list-disc">
                {res.suppressed.slice(0, 12).map((s, i) => (
                  <li key={i}>
                    “{s.keyword}” ({departmentName(s.departmentId)}): {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ settings

function SettingsPanel() {
  const q = useRoutingSettings();
  const act = useAct();
  const [s, setS] = useState<RoutingSettings | null>(null);
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);
  if (!s) return <Section title="Automation settings">Loading…</Section>;
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data);
  const move = (i: number, dir: -1 | 1) => {
    const p = [...s.departmentPriority];
    const j = i + dir;
    if (j < 0 || j >= p.length) return;
    [p[i], p[j]] = [p[j]!, p[i]!];
    setS({ ...s, departmentPriority: p });
  };
  const toggleDisabled = (d: DepartmentId) =>
    setS({
      ...s,
      disabledDepartments: s.disabledDepartments.includes(d)
        ? s.disabledDepartments.filter((x) => x !== d)
        : [...s.disabledDepartments, d],
    });
  return (
    <Section title="Automation settings">
      <div className="grid gap-4 text-sm md:grid-cols-2">
        <fieldset className="space-y-1">
          <legend className="font-medium">Task assignment</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={s.assignmentMode === "automatic"}
              onChange={() => setS({ ...s, assignmentMode: "automatic" })}
            />
            Automatic: departments are assigned as soon as Planning classifies a prompt
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={s.assignmentMode === "approval"}
              onChange={() => setS({ ...s, assignmentMode: "approval" })}
            />
            Approval required: assignments wait for you (Claude itself is never paused)
          </label>
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="font-medium">Detection</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.promptClassification}
              onChange={(e) => setS({ ...s, promptClassification: e.target.checked })}
            />
            Classify prompts (in memory only, never stored)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.qaAutoDetect}
              onChange={(e) => setS({ ...s, qaAutoDetect: e.target.checked })}
            />
            QA auto-detection: activate QA when a real test command runs
          </label>
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="font-medium">Department priority (tie-breaker) and on/off</legend>
          {s.departmentPriority.map((d, i) => (
            <div key={d} className="flex items-center gap-2">
              <span className="muted w-4">{i + 1}.</span>
              <span className="w-40">{departmentName(d)}</span>
              <button
                className="btn px-2 py-0.5"
                onClick={() => move(i, -1)}
                aria-label={`Raise ${d}`}
                disabled={i === 0}
              >
                ↑
              </button>
              <button
                className="btn px-2 py-0.5"
                onClick={() => move(i, 1)}
                aria-label={`Lower ${d}`}
                disabled={i === s.departmentPriority.length - 1}
              >
                ↓
              </button>
              <label className="ml-2 flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={!s.disabledDepartments.includes(d)}
                  disabled={d === "planning"}
                  onChange={() => toggleDisabled(d)}
                />
                {d === "planning" ? "always on" : "enabled"}
              </label>
            </div>
          ))}
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="font-medium">Timeouts</legend>
          <label className="flex items-center gap-2">
            <input
              className="input"
              style={{ width: 80 }}
              type="number"
              min={15}
              max={3600}
              value={Math.round(s.inactivityMs / 1000)}
              onChange={(e) => setS({ ...s, inactivityMs: Number(e.target.value) * 1000 })}
            />
            s without events → show department as waiting (state unknown)
          </label>
          <label className="flex items-center gap-2">
            <input
              className="input"
              style={{ width: 80 }}
              type="number"
              min={1}
              max={1440}
              value={Math.round(s.itemTimeoutMs / 60000)}
              onChange={(e) => setS({ ...s, itemTimeoutMs: Number(e.target.value) * 60000 })}
            />
            min without events → mark a mid-turn task “unknown”
          </label>
          <p className="muted text-xs">
            Launching independent agents: not available. No supported execution method is configured, so the
            router only observes and assigns.
          </p>
        </fieldset>
      </div>
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={!dirty}
          onClick={() =>
            void act(() => api("PATCH", "/api/routing/settings", s), "Automation settings saved.")
          }
        >
          Save settings
        </button>
        <button className="btn" disabled={!dirty} onClick={() => setS(q.data ?? null)}>
          Discard
        </button>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ rules

function Chips({
  words,
  onChange,
  label,
  mono,
}: {
  words: string[];
  onChange(w: string[]): void;
  label: string;
  mono?: boolean;
}) {
  const [add, setAdd] = useState("");
  const commit = () => {
    const parts = add
      .split(mono ? /\n/ : /,/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length) onChange([...new Set([...words, ...parts])]);
    setAdd("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {words.map((w) => (
        <span key={w} className={`badge inline-flex items-center gap-1 ${mono ? "font-mono" : ""}`}>
          {w}
          <button
            className="muted hover:text-[var(--bad)]"
            aria-label={`Remove ${label} ${w}`}
            onClick={() => onChange(words.filter((x) => x !== w))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className={`input py-0.5 text-xs ${mono ? "font-mono" : ""}`}
        style={{ width: 170 }}
        placeholder={mono ? "add pattern ⏎" : "add word ⏎"}
        aria-label={`Add ${label}`}
        value={add}
        onChange={(e) => setAdd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

function RuleRow({ rule }: { rule: RoutingRule }) {
  const act = useAct();
  const [r, setR] = useState(rule);
  useEffect(() => setR(rule), [rule]);
  const dirty = JSON.stringify(r) !== JSON.stringify(rule);
  const activity = r.triggerType === "activity";
  const save = (next: RoutingRule) =>
    act(
      () =>
        api("PATCH", `/api/routing/rules/${encodeURIComponent(rule.id)}`, {
          name: next.name,
          departmentId: next.departmentId,
          keywords: next.keywords,
          contextWords: next.contextWords,
          priority: next.priority,
          enabled: next.enabled,
          action: next.action,
          conditions: next.conditions,
        }),
      "Rule saved.",
    );
  return (
    <div
      className="panel2 space-y-2 p-3 text-sm"
      data-testid={`rule-${rule.id}`}
      style={{ opacity: r.enabled ? 1 : 0.6 }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={r.enabled}
            aria-label={`Enable ${r.name}`}
            onChange={(e) => {
              const next = { ...r, enabled: e.target.checked };
              setR(next);
              void save(next);
            }}
          />
          <span className="font-semibold">{r.name}</span>
        </label>
        <span className="badge">{activity ? "observed activity" : "prompt"}</span>
        <select
          className="input py-0.5 text-xs"
          style={{ width: "auto" }}
          aria-label="Department"
          value={r.departmentId}
          onChange={(e) => setR({ ...r, departmentId: e.target.value as DepartmentId })}
        >
          {DEPT_IDS.map((d) => (
            <option key={d} value={d}>
              {departmentName(d)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs">
          priority
          <input
            className="input py-0.5"
            style={{ width: 64 }}
            type="number"
            min={0}
            max={100}
            value={r.priority}
            onChange={(e) => setR({ ...r, priority: Number(e.target.value) })}
          />
        </label>
        <span className="muted text-xs">
          {r.builtin ? "built-in" : "custom"} · last triggered {ago(r.lastTriggeredAt)}
        </span>
        <span className="flex-1" />
        {dirty && (
          <>
            <button className="btn btn-primary py-0.5" onClick={() => void save(r)}>
              Save
            </button>
            <button className="btn py-0.5" onClick={() => setR(rule)}>
              Discard
            </button>
          </>
        )}
        {!r.builtin && (
          <button
            className="btn py-0.5"
            onClick={() => {
              if (confirm(`Delete rule "${r.name}"?`))
                void act(
                  () => api("DELETE", `/api/routing/rules/${encodeURIComponent(r.id)}`),
                  "Rule deleted.",
                );
            }}
          >
            Delete
          </button>
        )}
      </div>
      {r.description ? <div className="muted text-xs">{r.description}</div> : null}
      <div className="grid grid-cols-[110px_1fr] items-start gap-x-2 gap-y-1.5">
        <span className="muted text-xs">{activity ? "Command patterns" : "Action words"}</span>
        <Chips
          mono={activity}
          label="keyword"
          words={r.keywords}
          onChange={(keywords) => setR({ ...r, keywords })}
        />
        {!activity && (
          <>
            <span className="muted text-xs">Object words</span>
            <Chips
              label="object word"
              words={r.contextWords}
              onChange={(contextWords) => setR({ ...r, contextWords })}
            />
            <span className="muted text-xs">Then also</span>
            <div className="flex flex-wrap gap-3 text-xs">
              {DEPT_IDS.filter((d) => d !== "planning" && d !== r.departmentId).map((d) => (
                <label key={d} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={r.action.followUp.includes(d)}
                    onChange={(e) =>
                      setR({
                        ...r,
                        action: {
                          ...r.action,
                          followUp: e.target.checked
                            ? [...r.action.followUp, d]
                            : r.action.followUp.filter((x) => x !== d),
                        },
                      })
                    }
                  />
                  {departmentName(d)}
                </label>
              ))}
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={r.action.mode === "suggest"}
                  onChange={(e) =>
                    setR({ ...r, action: { ...r.action, mode: e.target.checked ? "suggest" : "assign" } })
                  }
                />
                suggest only (do not assign)
              </label>
            </div>
          </>
        )}
        {activity && (
          <>
            <span className="muted text-xs">Applies</span>
            <select
              className="input py-0.5 text-xs"
              style={{ width: "auto" }}
              value={r.conditions.scope}
              onChange={(e) =>
                setR({
                  ...r,
                  conditions: { ...r.conditions, scope: e.target.value as "always" | "task-or-project" },
                })
              }
            >
              <option value="always">always</option>
              <option value="task-or-project">
                only when the task or project already involves this department
              </option>
            </select>
          </>
        )}
      </div>
    </div>
  );
}

function NewRule() {
  const act = useAct();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [dept, setDept] = useState<DepartmentId>("dev");
  const [trigger, setTrigger] = useState<"prompt" | "activity">("prompt");
  const [words, setWords] = useState("");
  if (!open)
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        + Add rule
      </button>
    );
  const create = async () => {
    const keywords = words
      .split(trigger === "activity" ? /\n/ : /,/)
      .map((w) => w.trim())
      .filter(Boolean);
    const ok = await act(
      () =>
        api("POST", "/api/routing/rules", {
          id:
            id ||
            name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, ""),
          name,
          departmentId: dept,
          triggerType: trigger,
          keywords,
          conditions:
            trigger === "activity"
              ? { activity: dept === "video" ? "media-command" : "verification-command", scope: "always" }
              : { scope: "always" },
        }),
      "Rule added.",
    );
    if (ok) {
      setOpen(false);
      setId("");
      setName("");
      setWords("");
    }
  };
  return (
    <div className="panel2 space-y-2 p-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <input
          className="input"
          style={{ width: 220 }}
          placeholder="Rule name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Rule name"
        />
        <input
          className="input"
          style={{ width: 160 }}
          placeholder="id (optional)"
          value={id}
          onChange={(e) => setId(e.target.value)}
          aria-label="Rule id"
        />
        <select
          className="input"
          style={{ width: "auto" }}
          value={dept}
          onChange={(e) => setDept(e.target.value as DepartmentId)}
          aria-label="Department"
        >
          {DEPT_IDS.map((d) => (
            <option key={d} value={d}>
              {departmentName(d)}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ width: "auto" }}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value as "prompt" | "activity")}
          aria-label="Trigger"
        >
          <option value="prompt">Prompt words</option>
          <option value="activity">Observed command (regex)</option>
        </select>
      </div>
      <textarea
        className="input w-full font-mono text-xs"
        placeholder={
          trigger === "prompt"
            ? "Action words or phrases, comma-separated (e.g. vlog, make teaser)"
            : "One regular expression per line (e.g. \\beslint\\b)"
        }
        value={words}
        onChange={(e) => setWords(e.target.value)}
        aria-label="Trigger words"
      />
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={!name.trim() || !words.trim()}
          onClick={() => void create()}
        >
          Create
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RulesPanel() {
  const rules = useRoutingRules();
  const act = useAct();
  const prompt = rules.data?.filter((r) => r.triggerType === "prompt") ?? [];
  const activity = rules.data?.filter((r) => r.triggerType === "activity") ?? [];
  return (
    <Section
      title="Rules"
      help="Action words count only when they are the requested action: not inside quotes or code, not negated, not the topic of a research question, and not the object of another action. Generic verbs (create, make, run, fix…) are resolved by their object words."
    >
      <div className="flex flex-wrap gap-2">
        <NewRule />
        <button
          className="btn"
          onClick={() => {
            if (confirm("Restore all built-in rules to their defaults? Your custom rules are kept."))
              void act(() => api("POST", "/api/routing/rules/reset"), "Built-in rules restored.");
          }}
        >
          Restore built-in defaults
        </button>
      </div>
      <h4 className="text-sm font-medium">Prompt rules</h4>
      <div className="space-y-2">
        {prompt.map((r) => (
          <RuleRow key={r.id} rule={r} />
        ))}
      </div>
      <h4 className="text-sm font-medium">Observed activity rules (QA auto-detection and media)</h4>
      <div className="space-y-2">
        {activity.map((r) => (
          <RuleRow key={r.id} rule={r} />
        ))}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ work items + history

function ItemCard({ item }: { item: WorkItem }) {
  const act = useAct();
  const [reassign, setReassign] = useState<DepartmentId[] | null>(null);
  const open = !item.closedAt;
  const statusColor = BAD.has(item.status)
    ? "var(--bad)"
    : GOOD.has(item.status)
      ? "var(--good)"
      : "var(--accent)";
  const doAction = (action: string, extra: Record<string, unknown> = {}) =>
    act(
      () => api("POST", `/api/routing/items/${item.id}/action`, { action, ...extra }),
      "Done. Recorded in the routing history.",
    );
  const pendingApproval = item.stages.some((s) => !s.approved);
  return (
    <div className="panel2 space-y-1.5 p-3 text-sm" data-testid="work-item">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{item.title}</span>
        <span className="badge" style={{ color: statusColor, borderColor: statusColor }}>
          {STATUS_TEXT[item.status] ?? item.status}
        </span>
        {item.version > 1 && <span className="badge">revision {item.version}</span>}
        <span className="muted text-xs">
          session {item.sessionId?.slice(0, 8) ?? "–"} · {ago(item.createdAt)} · last event{" "}
          {ago(item.lastEventAt)}
          {item.taskId ? " · linked to a board task" : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {item.stages.map((s) => (
          <span key={s.departmentId} className="flex items-center gap-1 text-xs" title={s.reason}>
            <span>{departmentName(s.departmentId)}</span>
            <StateBadge state={s.state} />
            {s.qaResult ? <span className="muted">tests {s.qaResult}</span> : null}
          </span>
        ))}
      </div>
      {item.stages
        .filter((s) => s.evidence.length)
        .map((s) => (
          <ul key={s.departmentId} className="muted ml-4 list-disc text-xs">
            {s.evidence.slice(-3).map((e) => (
              <li key={e.eventId}>
                {e.result === "running" ? "running" : e.result}: {e.summary} ({ago(e.at)}, event{" "}
                {e.eventId.slice(0, 10)})
              </li>
            ))}
          </ul>
        ))}
      {item.closeReason ? <div className="muted text-xs">{item.closeReason}</div> : null}
      {open && (
        <div className="flex flex-wrap gap-2">
          {pendingApproval && (
            <button className="btn btn-primary py-0.5" onClick={() => void doAction("approve")}>
              Approve assignment
            </button>
          )}
          <button
            className="btn py-0.5"
            onClick={() => {
              const failed = item.stages.some((s) => s.qaResult === "failed");
              if (
                !failed ||
                confirm(
                  "Verification failed for this task. Accept the outcome anyway? This is recorded as your decision.",
                )
              )
                void doAction("accept");
            }}
          >
            Accept outcome
          </button>
          <button
            className="btn py-0.5"
            onClick={() =>
              setReassign(item.stages.map((s) => s.departmentId).filter((d) => d !== "planning"))
            }
          >
            Reassign…
          </button>
          <button className="btn py-0.5" onClick={() => void doAction("cancel")}>
            Cancel task
          </button>
        </div>
      )}
      {reassign && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {DEPT_IDS.filter((d) => d !== "planning").map((d) => (
            <label key={d} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={reassign.includes(d)}
                onChange={(e) =>
                  setReassign(e.target.checked ? [...reassign, d] : reassign.filter((x) => x !== d))
                }
              />
              {departmentName(d)}
            </label>
          ))}
          <button
            className="btn btn-primary py-0.5"
            disabled={!reassign.length}
            onClick={() => void doAction("reassign", { departments: reassign }).then(() => setReassign(null))}
          >
            Apply
          </button>
          <button className="btn py-0.5" onClick={() => setReassign(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

function ItemsPanel() {
  const [which, setWhich] = useState<"open" | "all">("open");
  const items = useWorkItems(which, 30);
  return (
    <Section
      title="Routed tasks"
      help="One task per routed prompt. States change only from observed Claude Code events or your actions. A turn that ends without observed work, or with failing tests, is never shown as completed."
    >
      <div className="flex gap-2 text-sm">
        <button className={`btn ${which === "open" ? "btn-primary" : ""}`} onClick={() => setWhich("open")}>
          Open
        </button>
        <button className={`btn ${which === "all" ? "btn-primary" : ""}`} onClick={() => setWhich("all")}>
          Recent (all)
        </button>
      </div>
      {items.data?.length ? (
        <div className="space-y-2">
          {items.data.map((i) => (
            <ItemCard key={i.id} item={i} />
          ))}
        </div>
      ) : (
        <p className="muted text-sm">
          {which === "open" ? "No open tasks." : "No routed tasks yet."} Tasks appear when an observed Claude
          Code session receives a prompt.
        </p>
      )}
    </Section>
  );
}

function HistoryPanel() {
  const log = useRoutingLog(100);
  return (
    <Section
      title="Routing history"
      help="Audit log of every decision, assignment, state change, override and error."
    >
      <div className="max-h-80 overflow-y-auto">
        <table className="w-full text-left text-xs">
          <thead className="muted">
            <tr>
              <th className="py-1 pr-2">When</th>
              <th className="pr-2">Kind</th>
              <th className="pr-2">Dept</th>
              <th className="pr-2">By</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {log.data?.map((l) => (
              <tr key={l.id} style={{ borderTop: "1px solid var(--line)" }}>
                <td className="py-1 pr-2 whitespace-nowrap" title={l.ts}>
                  {ago(l.ts)}
                </td>
                <td className="pr-2" style={{ color: l.kind === "error" ? "var(--bad)" : undefined }}>
                  {l.kind}
                </td>
                <td className="pr-2">{l.departmentId ?? ""}</td>
                <td className="pr-2">{l.actor === "user" ? "you" : "router"}</td>
                <td>{l.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!log.data?.length && <p className="muted text-sm">Nothing yet.</p>}
      </div>
    </Section>
  );
}

export function AutomationView() {
  const deps = useStore((s) => s.departments);
  const live = useMemo(() => deps, [deps]);
  return (
    <div className="space-y-4" data-testid="automation-view">
      <Section
        title="Departments now"
        help="Planning coordinates every prompt. Other departments activate only from routed prompts and observed activity."
      >
        <div className="flex flex-wrap gap-2">
          {live.length ? (
            live.map((d) => <DepartmentCard key={d.departmentId} d={d} />)
          ) : (
            <span className="muted text-sm">Waiting for the server…</span>
          )}
        </div>
      </Section>
      <TestPrompt />
      <ItemsPanel />
      <SettingsPanel />
      <RulesPanel />
      <HistoryPanel />
    </div>
  );
}
