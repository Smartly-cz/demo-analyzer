import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(__dirname, "..", "demo-analyzer.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('fathom', 'granola', 'unknown')),
      date TEXT,
      participants TEXT,
      raw_text TEXT NOT NULL,
      parsed_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
      summary TEXT,
      lead_score INTEGER CHECK(lead_score BETWEEN 1 AND 10),
      lead_qualification TEXT,
      pain_points TEXT,
      objections TEXT,
      competitors_mentioned TEXT,
      next_steps TEXT,
      sentiment TEXT,
      key_quotes TEXT,
      custom_fields TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS content_ideas (
      id TEXT PRIMARY KEY,
      transcript_id TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      target_audience TEXT,
      based_on TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS aggregate_reports (
      id TEXT PRIMARY KEY,
      analyses_hash TEXT NOT NULL,
      analyses_count INTEGER NOT NULL,
      report TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pattern_reports (
      id TEXT PRIMARY KEY,
      analyses_hash TEXT NOT NULL,
      analyses_count INTEGER NOT NULL,
      report TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate: add new analysis columns (safe to run repeatedly — silently ignored if already exist)
  const newCols = [
    "feature_requests TEXT",
    "decision_process TEXT",
    "buying_triggers TEXT",
    "current_tools TEXT",
    "use_cases TEXT",
    "company_signals TEXT",
    "commitment_signals TEXT",
    "prospect_questions TEXT",
  ];
  for (const col of newCols) {
    try {
      db.exec(`ALTER TABLE analyses ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }
}

export interface TranscriptRow {
  id: string;
  title: string;
  source: string;
  date: string | null;
  participants: string | null;
  raw_text: string;
  parsed_text: string;
  created_at: string;
  updated_at: string;
}

export interface AnalysisRow {
  id: string;
  transcript_id: string;
  summary: string | null;
  lead_score: number | null;
  lead_qualification: string | null;
  pain_points: string | null;
  objections: string | null;
  competitors_mentioned: string | null;
  next_steps: string | null;
  sentiment: string | null;
  key_quotes: string | null;
  custom_fields: string | null;
  feature_requests: string | null;
  decision_process: string | null;
  buying_triggers: string | null;
  current_tools: string | null;
  use_cases: string | null;
  company_signals: string | null;
  commitment_signals: string | null;
  prospect_questions: string | null;
  created_at: string;
}

export interface ContentIdeaRow {
  id: string;
  transcript_id: string | null;
  title: string;
  type: string;
  description: string;
  target_audience: string | null;
  based_on: string | null;
  created_at: string;
}

export function insertTranscript(t: Omit<TranscriptRow, "created_at" | "updated_at">) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO transcripts (id, title, source, date, participants, raw_text, parsed_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(t.id, t.title, t.source, t.date, t.participants, t.raw_text, t.parsed_text);
}

export function getTranscript(id: string): TranscriptRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM transcripts WHERE id = ?").get(id) as TranscriptRow | undefined;
}

export function listTranscripts(): TranscriptRow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM transcripts ORDER BY created_at DESC").all() as TranscriptRow[];
}

export function listUnanalyzedTranscripts(): TranscriptRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT t.* FROM transcripts t
    LEFT JOIN analyses a ON a.transcript_id = t.id
    WHERE a.id IS NULL
    ORDER BY t.created_at DESC
  `).all() as TranscriptRow[];
}

export function deleteTranscript(id: string) {
  const db = getDb();
  db.prepare("DELETE FROM transcripts WHERE id = ?").run(id);
}

export function deleteAnalysisByTranscript(transcriptId: string) {
  const db = getDb();
  db.prepare("DELETE FROM analyses WHERE transcript_id = ?").run(transcriptId);
  db.prepare("DELETE FROM content_ideas WHERE transcript_id = ?").run(transcriptId);
}

export function insertAnalysis(a: Omit<AnalysisRow, "created_at">) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO analyses (id, transcript_id, summary, lead_score, lead_qualification,
      pain_points, objections, competitors_mentioned, next_steps, sentiment, key_quotes, custom_fields,
      feature_requests, decision_process, buying_triggers, current_tools, use_cases,
      company_signals, commitment_signals, prospect_questions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    a.id, a.transcript_id, a.summary, a.lead_score, a.lead_qualification,
    a.pain_points, a.objections, a.competitors_mentioned, a.next_steps,
    a.sentiment, a.key_quotes, a.custom_fields,
    a.feature_requests, a.decision_process, a.buying_triggers, a.current_tools,
    a.use_cases, a.company_signals, a.commitment_signals, a.prospect_questions
  );
}

export function getAnalysisByTranscript(transcriptId: string): AnalysisRow | undefined {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM analyses WHERE transcript_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(transcriptId) as AnalysisRow | undefined;
}

export function insertContentIdea(c: Omit<ContentIdeaRow, "created_at">) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO content_ideas (id, transcript_id, title, type, description, target_audience, based_on)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(c.id, c.transcript_id, c.title, c.type, c.description, c.target_audience, c.based_on);
}

export function getContentIdeasByTranscript(transcriptId: string): ContentIdeaRow[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM content_ideas WHERE transcript_id = ? ORDER BY created_at DESC"
  ).all(transcriptId) as ContentIdeaRow[];
}

export function listContentIdeas(): ContentIdeaRow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM content_ideas ORDER BY created_at DESC").all() as ContentIdeaRow[];
}

// ── Aggregate reports ───────────────────────────────────────────────

export interface AggregateReportRow {
  id: string;
  analyses_hash: string;
  analyses_count: number;
  report: string;
  created_at: string;
}

export function listAllAnalyses(): AnalysisRow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM analyses ORDER BY created_at DESC").all() as AnalysisRow[];
}

export function getAnalysisWithTranscript(): { analysis: AnalysisRow; title: string; date: string | null; participants: string | null }[] {
  const db = getDb();
  return db.prepare(`
    SELECT a.*, t.title, t.date, t.participants
    FROM analyses a
    JOIN transcripts t ON t.id = a.transcript_id
    ORDER BY a.created_at DESC
  `).all() as any[];
}

export function getLatestAggregateReport(): AggregateReportRow | undefined {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM aggregate_reports ORDER BY created_at DESC LIMIT 1"
  ).get() as AggregateReportRow | undefined;
}

export function insertAggregateReport(r: Omit<AggregateReportRow, "created_at">) {
  const db = getDb();
  db.prepare(`
    INSERT INTO aggregate_reports (id, analyses_hash, analyses_count, report)
    VALUES (?, ?, ?, ?)
  `).run(r.id, r.analyses_hash, r.analyses_count, r.report);
}

// ── Pattern reports (cross-call clustering) ─────────────────────────

export function getLatestPatternReport(): AggregateReportRow | undefined {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM pattern_reports ORDER BY created_at DESC LIMIT 1"
  ).get() as AggregateReportRow | undefined;
}

export function insertPatternReport(r: Omit<AggregateReportRow, "created_at">) {
  const db = getDb();
  db.prepare(`
    INSERT INTO pattern_reports (id, analyses_hash, analyses_count, report)
    VALUES (?, ?, ?, ?)
  `).run(r.id, r.analyses_hash, r.analyses_count, r.report);
}

export function getAnalysesHash(): string {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id FROM analyses ORDER BY id"
  ).all() as { id: string }[];
  // Simple hash: sorted IDs joined, then hashed via length+content checksum
  const joined = rows.map((r) => r.id).join(",");
  let hash = 0;
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash << 5) - hash + joined.charCodeAt(i)) | 0;
  }
  return `${rows.length}:${hash}`;
}
