import type { PluginInspectionSnapshot } from "./types.js";
import type {
  PluginDisableAssessment, PluginDisableEvidence, PluginSelection,
  PluginStopDisposition, PluginStopReport, PluginStopSubject,
} from "./management-types.js";
import { previewPluginSelection } from "./selection.js";

const priority: Record<PluginStopDisposition, number> = {
  direct: 0, drain: 1, maintenance: 2, restart: 3, blocked: 4,
};

/** Pure reduction of fresh Host-owned reports. It neither stops work nor grants permission. */
export function assessPluginDisable(
  snapshot: PluginInspectionSnapshot,
  selection: PluginSelection,
  evidence?: PluginDisableEvidence,
): PluginDisableAssessment {
  const impact = previewPluginSelection(snapshot, selection);
  const conditions: Array<PluginDisableAssessment["conditions"][number]> = [];
  const add = (
    subject: PluginStopSubject | { readonly kind: "host" },
    disposition: PluginStopDisposition,
    code: string,
  ) => {
    const safeSubject = subject.kind === "entry"
      ? { kind: "entry" as const, entryId: subject.entryId }
      : subject.kind === "fiber" ? { kind: "fiber" as const, fiberId: subject.fiberId }
      : { kind: "host" as const };
    conditions.push(Object.freeze({ subject: Object.freeze(safeSubject), disposition, code }));
  };
  const host = { kind: "host" } as const;
  if (evidence !== undefined && evidence?.observation !== snapshot) {
    add(host, "blocked", "evidence_observation_mismatch");
  }
  if (evidence?.configuration !== "managed") {
    add(host, evidence?.configuration === "read-only" ? "maintenance" : "blocked",
      evidence?.configuration === "read-only" ? "configuration_read_only" : "configuration_unassessed");
  }
  if (evidence?.recovery !== "available") {
    const recovery = evidence?.recovery;
    add(host, recovery === "maintenance" || recovery === "restart" ? recovery : "blocked",
      recovery === "maintenance" || recovery === "restart" ? "recovery_requires_intervention" : "recovery_unassessed");
  }
  if (evidence?.admission !== "guarded") add(host, "blocked", "admission_unassessed");

  const required: PluginStopSubject[] = [
    ...impact.gatedEntryIds.map(entryId => ({ kind: "entry" as const, entryId })),
    ...impact.affected.map(({ fiberId }) => ({ kind: "fiber" as const, fiberId })),
  ];
  const requiredKeys = new Set(required.map(subjectKey));
  const reports = new Map<string, PluginStopReport>();
  if (evidence?.reports !== undefined && !Array.isArray(evidence.reports)) {
    add(host, "blocked", "invalid_lifecycle_report");
  }
  for (const report of Array.isArray(evidence?.reports) ? evidence.reports : []) {
    if (!validReport(report)) {
      add(host, "blocked", "invalid_lifecycle_report");
      continue;
    }
    const key = subjectKey(report.subject);
    if (!requiredKeys.has(key) || reports.has(key)) {
      add(host, "blocked", "invalid_lifecycle_report");
      continue;
    }
    reports.set(key, report);
  }
  for (const subject of required) {
    const report = reports.get(subjectKey(subject));
    if (report === undefined) {
      add(subject, "blocked", "lifecycle_unassessed");
    } else {
      add(subject, report.disposition, report.code);
    }
  }
  // A module cannot waive an already observed transition or failed gate evaluation.
  const observedEntryIds = new Set(impact.gatedEntryIds);
  for (const { fiberId } of impact.affected) {
    const entryId = snapshot.fibers.find(item => item.id === fiberId)?.entryId;
    if (entryId != null) observedEntryIds.add(entryId);
  }
  for (const id of observedEntryIds) {
    const entry = snapshot.entries.find(item => item.id === id)!;
    if (entry.enabled === null) add({ kind: "entry", entryId: id }, "blocked", "gate_unknown");
    if (entry.phase === "loading" || entry.phase === "unloading") {
      add({ kind: "entry", entryId: id }, "blocked", "lifecycle_in_transition");
    }
  }
  for (const { fiberId } of impact.affected) {
    const fiber = snapshot.fibers.find(item => item.id === fiberId);
    if (!fiber || fiber.phase === "loading" || fiber.phase === "unloading") {
      add({ kind: "fiber", fiberId }, "blocked", "lifecycle_in_transition");
    }
  }
  const disposition = conditions.reduce<PluginStopDisposition>((result, condition) =>
    priority[condition.disposition] > priority[result] ? condition.disposition : result, "direct");
  return Object.freeze({ impact, disposition, conditions: Object.freeze(conditions), safety: "requires-execution-check" });
}

function subjectKey(subject: PluginStopSubject): string {
  return subject.kind === "entry" ? `entry:${subject.entryId}` : `fiber:${subject.fiberId}`;
}

function validReport(report: PluginStopReport): boolean {
  if (!report || typeof report !== "object" || !report.subject ||
    typeof report.disposition !== "string" || !Object.hasOwn(priority, report.disposition) ||
    typeof report.code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/u.test(report.code)) return false;
  const subject = report.subject;
  if (subject.kind === "entry") return typeof subject.entryId === "string" && subject.entryId.length > 0;
  return subject.kind === "fiber" && Number.isSafeInteger(subject.fiberId) && subject.fiberId >= 0;
}
