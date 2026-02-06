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
  deleteTranscript,
  getAnalysisByTranscript,
  getContentIdeasByTranscript,
  listContentIdeas,
} from "./database";
import { parseTranscript } from "./parsers";
import { analyzeTranscript } from "./analyzer";

const router = Router();

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

// ── Analyze a transcript ────────────────────────────────────────────
router.post("/api/transcripts/:id/analyze", async (req: Request<IdParams>, res: Response) => {
  try {
    const transcript = getTranscript(req.params.id);
    if (!transcript) {
      res.status(404).json({ error: "Transcript not found" });
      return;
    }

    const result = await analyzeTranscript(transcript.id, transcript.parsed_text);

    res.json({
      analysis: {
        ...result.analysis,
        pain_points: safeJsonParse(result.analysis.pain_points),
        objections: safeJsonParse(result.analysis.objections),
        competitors_mentioned: safeJsonParse(result.analysis.competitors_mentioned),
        next_steps: safeJsonParse(result.analysis.next_steps),
        key_quotes: safeJsonParse(result.analysis.key_quotes),
      },
      content_ideas: result.contentIdeas,
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
    analysis: {
      ...analysis,
      pain_points: safeJsonParse(analysis.pain_points),
      objections: safeJsonParse(analysis.objections),
      competitors_mentioned: safeJsonParse(analysis.competitors_mentioned),
      next_steps: safeJsonParse(analysis.next_steps),
      key_quotes: safeJsonParse(analysis.key_quotes),
    },
    content_ideas: contentIdeas,
  });
});

// ── List all content ideas ──────────────────────────────────────────
router.get("/api/content-ideas", (_req: Request, res: Response) => {
  res.json(listContentIdeas());
});

function safeJsonParse(val: string | null): any {
  if (!val) return null;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

export default router;
