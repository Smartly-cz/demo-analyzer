// In-memory job tracker for long-running analysis tasks.
// Jobs survive tab switches — the UI polls for status.

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface Job {
  id: string;
  type: "analyze" | "analyze-all" | "reanalyze-all";
  status: JobStatus;
  progress: { current: number; total: number };
  result: any | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const jobs = new Map<string, Job>();

// Auto-clean completed/failed jobs older than 30 minutes
const CLEANUP_AGE_MS = 30 * 60 * 1000;

function cleanup() {
  const cutoff = Date.now() - CLEANUP_AGE_MS;
  for (const [id, job] of jobs) {
    if ((job.status === "completed" || job.status === "failed") && job.updated_at < cutoff) {
      jobs.delete(id);
    }
  }
}

export function createJob(id: string, type: Job["type"], total: number = 1): Job {
  cleanup();
  const job: Job = {
    id,
    type,
    status: "pending",
    progress: { current: 0, total },
    result: null,
    error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, updates: Partial<Pick<Job, "status" | "progress" | "result" | "error">>) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, updates, { updated_at: Date.now() });
}

export function listActiveJobs(): Job[] {
  return Array.from(jobs.values()).filter(
    (j) => j.status === "pending" || j.status === "running"
  );
}
