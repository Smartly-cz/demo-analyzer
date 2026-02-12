import { Router, Request, Response } from "express";

interface IdParams {
  id: string;
  [key: string]: string;
}
import multer from "multer";
import { v4 as uuid } from "uuid";
import path from "path";
import {
  insertTranscript,
  getTranscript,
  listTranscripts,
  listUnanalyzedTranscripts,
  deleteTranscript,
  deleteAnalysisByTranscript,
  getAnalysisByTranscript,
  getContentIdeasByTranscript,
  listContentIdeas,
  listAllAnalyses,
  getLatestAggregateReport,
} from "./database";
import { parseTranscript } from "./parsers";
import { analyzeTranscript, generateAggregateReport, generatePatternReport } from "./analyzer";
import {
  FathomClient,
  fathomTranscriptToText,
  extractParticipants,
  FathomMeeting,
} from "./fathom-client";
import { createJob, getJob, updateJob, listActiveJobs } from "./jobs";

const router = Router();

// ── Job status endpoints ────────────────────────────────────────────
router.get("/api/jobs/active", (_req: Request, res: Response) => {
  res.json(listActiveJobs());
});

router.get("/api/jobs/:id", (req: Request<IdParams>, res: Response) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

// File upload config
const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowed = [".txt", ".md", ".vtt", ".srt", ".json"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not supported. Use: ${allowed.join(", ")}`));
    }
  },
});

// ── Upload transcript via file ──────────────────────────────────────
router.post("/api/transcripts/upload", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const fs = await import("fs/promises");
    const content = await fs.readFile(req.file.path, "utf-8");
    const parsed = parseTranscript(req.file.originalname, content);

    const id = uuid();
    insertTranscript({
      id,
      title: (req.body.title as string) || parsed.title,
      source: parsed.source,
      date: parsed.date,
      participants: JSON.stringify(parsed.participants),
      raw_text: content,
      parsed_text: parsed.text,
    });

    res.status(201).json({
      id,
      title: parsed.title,
      source: parsed.source,
      date: parsed.date,
      participants: parsed.participants,
      message: "Transcript uploaded successfully",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Import transcript via raw text (API) ────────────────────────────
router.post("/api/transcripts", async (req: Request, res: Response) => {
  try {
    const { title, text, source, date } = req.body;
    if (!text) {
      res.status(400).json({ error: "\"text\" field is required" });
      return;
    }

    const filename = (title || "transcript") + ".txt";
    const parsed = parseTranscript(filename, text);

    const id = uuid();
    insertTranscript({
      id,
      title: title || parsed.title,
      source: source || parsed.source,
      date: date || parsed.date,
      participants: JSON.stringify(parsed.participants),
      raw_text: text,
      parsed_text: parsed.text,
    });

    res.status(201).json({
      id,
      title: title || parsed.title,
      source: source || parsed.source,
      participants: parsed.participants,
      message: "Transcript imported successfully",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── List all transcripts ────────────────────────────────────────────
router.get("/api/transcripts", (_req: Request, res: Response) => {
  const transcripts = listTranscripts().map((t) => ({
    ...t,
    participants: safeJsonParse(t.participants),
    // Don't send full text in list view
    raw_text: undefined,
    parsed_text: undefined,
    text_preview: t.parsed_text.substring(0, 200) + (t.parsed_text.length > 200 ? "..." : ""),
  }));
  res.json(transcripts);
});

// ── Analyze all unanalyzed transcripts (background job) ─────────────
// MUST be registered before :id routes to avoid path conflicts
router.post("/api/transcripts/analyze-all", async (_req: Request, res: Response) => {
  try {
    const unanalyzed = listUnanalyzedTranscripts();
    if (unanalyzed.length === 0) {
      res.json({ message: "All transcripts already analyzed", analyzed: 0, failed: 0, results: [], job_id: null });
      return;
    }

    const jobId = uuid();
    createJob(jobId, "analyze-all", unanalyzed.length);
    res.json({ job_id: jobId, total: unanalyzed.length, message: "Analysis started in background" });

    // Run in background (after response is sent)
    (async () => {
      updateJob(jobId, { status: "running" });
      const results: any[] = [];
      const failures: any[] = [];

      for (const transcript of unanalyzed) {
        try {
          const result = await analyzeTranscript(transcript.id, transcript.parsed_text);
          results.push({
            id: transcript.id,
            title: transcript.title,
            lead_score: result.analysis.lead_score,
            lead_qualification: result.analysis.lead_qualification,
          });
        } catch (err: any) {
          failures.push({ id: transcript.id, title: transcript.title, error: err.message });
        }
        updateJob(jobId, {
          progress: { current: results.length + failures.length, total: unanalyzed.length },
        });
      }

      updateJob(jobId, {
        status: "completed",
        result: {
          message: `Analyzed ${results.length} transcript(s)`,
          analyzed: results.length,
          failed: failures.length,
          total: unanalyzed.length,
          results,
          failures: failures.length > 0 ? failures : undefined,
        },
      });
    })().catch((err) => {
      updateJob(jobId, { status: "failed", error: err.message });
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Re-analyze ALL transcripts (force, background job) ──────────────
router.post("/api/transcripts/reanalyze-all", async (_req: Request, res: Response) => {
  try {
    const all = listTranscripts();
    if (all.length === 0) {
      res.json({ message: "No transcripts to re-analyze", analyzed: 0, failed: 0, results: [], job_id: null });
      return;
    }

    const jobId = uuid();
    createJob(jobId, "reanalyze-all", all.length);
    res.json({ job_id: jobId, total: all.length, message: "Re-analysis started in background" });

    (async () => {
      updateJob(jobId, { status: "running" });
      const results: any[] = [];
      const failures: any[] = [];

      for (const transcript of all) {
        try {
          const result = await analyzeTranscript(transcript.id, transcript.parsed_text, true);
          results.push({
            id: transcript.id,
            title: transcript.title,
            lead_score: result.analysis.lead_score,
            lead_qualification: result.analysis.lead_qualification,
          });
        } catch (err: any) {
          failures.push({ id: transcript.id, title: transcript.title, error: err.message });
        }
        updateJob(jobId, {
          progress: { current: results.length + failures.length, total: all.length },
        });
      }

      updateJob(jobId, {
        status: "completed",
        result: {
          message: `Re-analyzed ${results.length} transcript(s)`,
          analyzed: results.length,
          failed: failures.length,
          total: all.length,
          results,
          failures: failures.length > 0 ? failures : undefined,
        },
      });
    })().catch((err) => {
      updateJob(jobId, { status: "failed", error: err.message });
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get single transcript ───────────────────────────────────────────
router.get("/api/transcripts/:id", (req: Request<IdParams>, res: Response) => {
  const transcript = getTranscript(req.params.id);
  if (!transcript) {
    res.status(404).json({ error: "Transcript not found" });
    return;
  }
  res.json({
    ...transcript,
    participants: safeJsonParse(transcript.participants),
  });
});

// ── Delete transcript ───────────────────────────────────────────────
router.delete("/api/transcripts/:id", (req: Request<IdParams>, res: Response) => {
  const transcript = getTranscript(req.params.id);
  if (!transcript) {
    res.status(404).json({ error: "Transcript not found" });
    return;
  }
  deleteTranscript(req.params.id);
  res.json({ message: "Transcript deleted" });
});

// ── Delete analysis for a transcript ─────────────────────────────────
router.delete("/api/transcripts/:id/analysis", (req: Request<IdParams>, res: Response) => {
  const analysis = getAnalysisByTranscript(req.params.id);
  if (!analysis) {
    res.status(404).json({ error: "No analysis found for this transcript." });
    return;
  }
  deleteAnalysisByTranscript(req.params.id);
  res.json({ message: "Analysis and content ideas deleted" });
});

// ── Analyze a transcript (background job) ───────────────────────────
router.post("/api/transcripts/:id/analyze", async (req: Request<IdParams>, res: Response) => {
  try {
    const transcript = getTranscript(req.params.id);
    if (!transcript) {
      res.status(404).json({ error: "Transcript not found" });
      return;
    }

    const force = req.query.force === "true" || req.query.force === "1";

    // Check for existing analysis (return immediately if cached and not forcing)
    if (!force) {
      const existing = getAnalysisByTranscript(transcript.id);
      if (existing) {
        const ideas = getContentIdeasByTranscript(transcript.id);
        res.json({
          analysis: parseAnalysisJson(existing),
          content_ideas: ideas,
          job_id: null,
        });
        return;
      }
    }

    const jobId = uuid();
    createJob(jobId, "analyze", 1);
    res.json({ job_id: jobId, message: "Analysis started in background" });

    (async () => {
      updateJob(jobId, { status: "running" });
      const result = await analyzeTranscript(transcript.id, transcript.parsed_text, force);
      updateJob(jobId, {
        status: "completed",
        progress: { current: 1, total: 1 },
        result: {
          analysis: parseAnalysisJson(result.analysis),
          content_ideas: result.contentIdeas,
        },
      });
    })().catch((err) => {
      updateJob(jobId, { status: "failed", error: err.message });
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get analysis for a transcript ───────────────────────────────────
router.get("/api/transcripts/:id/analysis", (req: Request<IdParams>, res: Response) => {
  const analysis = getAnalysisByTranscript(req.params.id);
  if (!analysis) {
    res.status(404).json({ error: "No analysis found. POST to /api/transcripts/:id/analyze first." });
    return;
  }

  const contentIdeas = getContentIdeasByTranscript(req.params.id);

  res.json({
    analysis: parseAnalysisJson(analysis),
    content_ideas: contentIdeas,
  });
});

// ── List all content ideas ──────────────────────────────────────────
router.get("/api/content-ideas", (_req: Request, res: Response) => {
  res.json(listContentIdeas());
});

// ═══════════════════════════════════════════════════════════════════
// Dashboard — aggregate cross-call analysis
// ═══════════════════════════════════════════════════════════════════

// ── Quick stats (no AI, pure DB) ────────────────────────────────────
router.get("/api/dashboard/stats", (_req: Request, res: Response) => {
  try {
    const transcripts = listTranscripts();
    const analyses = listAllAnalyses();
    const unanalyzed = listUnanalyzedTranscripts();

    // Build stats from individual analyses
    let hot = 0, warm = 0, cold = 0, totalScore = 0;
    const painPointCounts: Record<string, number> = {};
    const objectionCounts: Record<string, number> = {};
    const competitorCounts: Record<string, number> = {};
    const sentimentCounts: Record<string, number> = {};
    const featureRequestCounts: Record<string, number> = {};
    const toolCounts: Record<string, number> = {};
    const questionCounts: Record<string, number> = {};
    const triggerCounts: Record<string, number> = {};

    for (const a of analyses) {
      const score = a.lead_score || 0;
      totalScore += score;
      if (score >= 7) hot++;
      else if (score >= 4) warm++;
      else cold++;

      if (a.sentiment) sentimentCounts[a.sentiment] = (sentimentCounts[a.sentiment] || 0) + 1;

      for (const field of [
        { data: a.pain_points, counts: painPointCounts },
        { data: a.objections, counts: objectionCounts },
        { data: a.competitors_mentioned, counts: competitorCounts },
        { data: a.feature_requests, counts: featureRequestCounts },
        { data: a.current_tools, counts: toolCounts },
        { data: a.prospect_questions, counts: questionCounts },
        { data: a.buying_triggers, counts: triggerCounts },
      ]) {
        try {
          const items: string[] = JSON.parse(field.data || "[]");
          for (const item of items) {
            field.counts[item] = (field.counts[item] || 0) + 1;
          }
        } catch {}
      }
    }

    const sortedEntries = (obj: Record<string, number>) =>
      Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

    res.json({
      total_transcripts: transcripts.length,
      analyzed: analyses.length,
      unanalyzed: unanalyzed.length,
      pipeline: {
        hot,
        warm,
        cold,
        avg_score: analyses.length > 0 ? Math.round((totalScore / analyses.length) * 10) / 10 : 0,
      },
      top_pain_points: sortedEntries(painPointCounts).slice(0, 10),
      top_objections: sortedEntries(objectionCounts).slice(0, 8),
      top_competitors: sortedEntries(competitorCounts).slice(0, 8),
      sentiment_breakdown: sentimentCounts,
      top_feature_requests: sortedEntries(featureRequestCounts).slice(0, 10),
      top_tools: sortedEntries(toolCounts).slice(0, 10),
      top_questions: sortedEntries(questionCounts).slice(0, 10),
      top_buying_triggers: sortedEntries(triggerCounts).slice(0, 8),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Aggregate AI report (cached, incremental) ──────────────────────
router.get("/api/dashboard/report", async (_req: Request, res: Response) => {
  try {
    const result = await generateAggregateReport(false);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/dashboard/report", async (_req: Request, res: Response) => {
  try {
    const result = await generateAggregateReport(true);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pattern detection (AI-powered clustering) ───────────────────────
router.get("/api/dashboard/patterns", async (_req: Request, res: Response) => {
  try {
    const result = await generatePatternReport(false);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/dashboard/patterns", async (_req: Request, res: Response) => {
  try {
    const result = await generatePatternReport(true);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Fathom Integration
// ═══════════════════════════════════════════════════════════════════

function getFathomClient(): FathomClient {
  const apiKey = process.env.FATHOM_API_KEY;
  if (!apiKey) {
    throw new Error("FATHOM_API_KEY is not set. Add it to your .env file.");
  }
  return new FathomClient({ apiKey });
}

// ── Test Fathom connection ──────────────────────────────────────────
router.get("/api/fathom/status", async (_req: Request, res: Response) => {
  try {
    const client = getFathomClient();
    const ok = await client.testConnection();
    res.json({ connected: ok });
  } catch (err: any) {
    res.json({ connected: false, error: err.message });
  }
});

// ── List calls from Fathom ──────────────────────────────────────────
router.get("/api/fathom/calls", async (req: Request, res: Response) => {
  try {
    const client = getFathomClient();

    const params: any = {};
    if (req.query.created_after) params.created_after = req.query.created_after as string;
    if (req.query.created_before) params.created_before = req.query.created_before as string;
    if (req.query.cursor) params.cursor = req.query.cursor as string;
    params.per_page = parseInt(req.query.per_page as string) || 25;

    const response = await client.listMeetings(params);

    res.json({
      calls: response.items.map((m) => ({
        recording_id: m.recording_id,
        title: m.title || m.meeting_title,
        created_at: m.created_at,
        participants: extractParticipants(m),
        url: m.url,
        share_url: m.share_url,
        has_transcript: !!m.transcript,
      })),
      next_cursor: response.next_cursor,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Import a single Fathom call ─────────────────────────────────────
router.post("/api/fathom/import/:recordingId", async (req: Request<{ recordingId: string; [key: string]: string }>, res: Response) => {
  try {
    const client = getFathomClient();
    const recordingId = parseInt(req.params.recordingId, 10);
    if (isNaN(recordingId)) {
      res.status(400).json({ error: "Invalid recording ID" });
      return;
    }

    // Fetch the meeting with transcript included
    const meetings = await client.listMeetings({
      include_transcript: true,
      per_page: 50,
    });

    const meeting = meetings.items.find((m) => m.recording_id === recordingId);

    let transcriptText: string;
    let participants: string[];
    let title: string;
    let date: string;

    if (meeting) {
      title = meeting.title || meeting.meeting_title;
      date = meeting.created_at;
      participants = extractParticipants(meeting);

      if (meeting.transcript && meeting.transcript.length > 0) {
        transcriptText = fathomTranscriptToText(meeting.transcript);
      } else {
        // Fetch transcript separately
        const transcriptResp = await client.getTranscript(recordingId);
        transcriptText = fathomTranscriptToText(transcriptResp.transcript);
      }
    } else {
      // Meeting not in recent list — fetch transcript directly
      const transcriptResp = await client.getTranscript(recordingId);
      transcriptText = fathomTranscriptToText(transcriptResp.transcript);
      title = `Fathom Call ${recordingId}`;
      date = new Date().toISOString();
      participants = [];
      const speakerNames = new Set<string>();
      for (const entry of transcriptResp.transcript) {
        if (entry.speaker.display_name) speakerNames.add(entry.speaker.display_name);
      }
      participants = Array.from(speakerNames);
    }

    const id = uuid();
    insertTranscript({
      id,
      title,
      source: "fathom",
      date,
      participants: JSON.stringify(participants),
      raw_text: transcriptText,
      parsed_text: transcriptText,
    });

    res.status(201).json({
      id,
      title,
      source: "fathom",
      date,
      participants,
      recording_id: recordingId,
      message: "Fathom call imported successfully",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk import all recent Fathom calls ─────────────────────────────
router.post("/api/fathom/import-all", async (req: Request, res: Response) => {
  try {
    const client = getFathomClient();

    const params: any = { include_transcript: true };
    if (req.body.created_after) params.created_after = req.body.created_after;
    if (req.body.created_before) params.created_before = req.body.created_before;

    const meetings = await client.getAllMeetings(params);
    const imported: { id: string; title: string; recording_id: number }[] = [];
    const skipped: { recording_id: number; reason: string }[] = [];

    for (const meeting of meetings) {
      let transcriptText: string;

      if (meeting.transcript && meeting.transcript.length > 0) {
        transcriptText = fathomTranscriptToText(meeting.transcript);
      } else {
        try {
          const transcriptResp = await client.getTranscript(meeting.recording_id);
          transcriptText = fathomTranscriptToText(transcriptResp.transcript);
        } catch {
          skipped.push({ recording_id: meeting.recording_id, reason: "Could not fetch transcript" });
          continue;
        }
      }

      if (!transcriptText.trim()) {
        skipped.push({ recording_id: meeting.recording_id, reason: "Empty transcript" });
        continue;
      }

      const id = uuid();
      const title = meeting.title || meeting.meeting_title;
      const participants = extractParticipants(meeting);

      insertTranscript({
        id,
        title,
        source: "fathom",
        date: meeting.created_at,
        participants: JSON.stringify(participants),
        raw_text: transcriptText,
        parsed_text: transcriptText,
      });

      imported.push({ id, title, recording_id: meeting.recording_id });
    }

    res.json({
      imported_count: imported.length,
      skipped_count: skipped.length,
      imported,
      skipped,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function parseAnalysisJson(a: any) {
  return {
    ...a,
    pain_points: safeJsonParse(a.pain_points),
    objections: safeJsonParse(a.objections),
    competitors_mentioned: safeJsonParse(a.competitors_mentioned),
    next_steps: safeJsonParse(a.next_steps),
    key_quotes: safeJsonParse(a.key_quotes),
    feature_requests: safeJsonParse(a.feature_requests),
    decision_process: safeJsonParse(a.decision_process),
    buying_triggers: safeJsonParse(a.buying_triggers),
    current_tools: safeJsonParse(a.current_tools),
    use_cases: safeJsonParse(a.use_cases),
    company_signals: safeJsonParse(a.company_signals),
    commitment_signals: safeJsonParse(a.commitment_signals),
    prospect_questions: safeJsonParse(a.prospect_questions),
  };
}

function safeJsonParse(val: string | null): any {
  if (!val) return null;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

export default router;
