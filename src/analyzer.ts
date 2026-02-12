import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuid } from "uuid";
import {
  insertAnalysis,
  insertContentIdea,
  getAnalysisByTranscript,
  getContentIdeasByTranscript,
  AnalysisRow,
  ContentIdeaRow,
} from "./database";

// Use Opus for deep research; override with ANTHROPIC_MODEL in .env (e.g. claude-sonnet-4-20250514 for cheaper)
const DEFAULT_MODEL = "claude-opus-4-5-20251101";

function getModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

let anthropic: Anthropic | null = null;

function getClaude(): Anthropic {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required. Set it in .env or your environment."
      );
    }
    anthropic = new Anthropic({ apiKey });
  }
  return anthropic;
}

function getTextFromMessage(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((block) => block.type === "text" && "text" in block)
    .map((b) => (b as { text: string }).text)
    .join("");
}

export interface AnalysisResult {
  summary: string;
  lead_score: number;
  lead_qualification: string;
  pain_points: string[];
  objections: string[];
  competitors_mentioned: string[];
  next_steps: string[];
  sentiment: string;
  key_quotes: string[];
}

export interface ContentIdea {
  title: string;
  type: string;
  description: string;
  target_audience: string;
  based_on: string;
}

const ANALYSIS_SYSTEM = `You are an expert sales analyst. Analyze demo call transcripts and provide a structured analysis. Always respond with valid JSON only, no markdown or extra text.`;

const ANALYSIS_USER_PREFIX = `Return a JSON object with these fields:
- "summary": A 2-3 sentence summary of the call
- "lead_score": Score from 1-10 (10 = very likely to convert)
- "lead_qualification": One of "Hot", "Warm", "Cold", "Not Qualified" with a brief explanation
- "pain_points": Array of specific pain points the prospect mentioned
- "objections": Array of objections or concerns raised
- "competitors_mentioned": Array of competitor names mentioned
- "next_steps": Array of agreed or suggested next steps
- "sentiment": Overall sentiment: "Very Positive", "Positive", "Neutral", "Negative", "Very Negative"
- "key_quotes": Array of 3-5 notable quotes from the prospect (verbatim or near-verbatim)

Be specific and reference actual content from the transcript. If a field has no data, use an empty array or appropriate default.

TRANSCRIPT:
`;

const CONTENT_IDEAS_SYSTEM = `You are a B2B content marketing strategist. Based on demo call transcripts, suggest content ideas that would resonate with similar prospects. Always respond with valid JSON only: either a JSON array of 3-5 content ideas, or a single object with an "ideas" or "content_ideas" array. No markdown or extra text.`;

const CONTENT_IDEAS_USER_PREFIX = `Return a JSON array of 3-5 content ideas. Each idea should be a JSON object with:
- "title": A compelling title for the content piece
- "type": One of "Blog Post", "Case Study", "Whitepaper", "Video", "Webinar", "Social Post", "Email Sequence", "FAQ", "Comparison Guide"
- "description": 2-3 sentences describing the content and angle
- "target_audience": Who this content is for
- "based_on": What specific part of the conversation inspired this idea

Focus on pain points, objections, and questions that came up. These are real signals from real prospects.

TRANSCRIPT:
`;

export async function analyzeTranscript(
  transcriptId: string,
  transcriptText: string
): Promise<{ analysis: AnalysisRow; contentIdeas: ContentIdeaRow[] }> {
  // Check for existing analysis
  const existing = getAnalysisByTranscript(transcriptId);
  if (existing) {
    const ideas = getContentIdeasByTranscript(transcriptId);
    return { analysis: existing, contentIdeas: ideas };
  }

  const client = getClaude();

  // Run analysis and content ideas in parallel (Claude for deep research on calls)
  const [analysisResponse, contentResponse] = await Promise.all([
    client.messages.create({
      model: getModel(),
      max_tokens: 4096,
      system: ANALYSIS_SYSTEM,
      messages: [
        {
          role: "user",
          content: ANALYSIS_USER_PREFIX + transcriptText,
        },
      ],
      temperature: 0.3,
    }),
    client.messages.create({
      model: getModel(),
      max_tokens: 4096,
      system: CONTENT_IDEAS_SYSTEM,
      messages: [
        {
          role: "user",
          content: CONTENT_IDEAS_USER_PREFIX + transcriptText,
        },
      ],
      temperature: 0.7,
    }),
  ]);

  const analysisRaw = getTextFromMessage(analysisResponse);
  const analysisData: AnalysisResult = JSON.parse(
    analysisRaw.trim().replace(/^```json\s*/i, "").replace(/\s*```\s*$/, "") || "{}"
  );

  const analysisId = uuid();
  const analysisRow: Omit<AnalysisRow, "created_at"> = {
    id: analysisId,
    transcript_id: transcriptId,
    summary: analysisData.summary || null,
    lead_score: analysisData.lead_score ?? null,
    lead_qualification: analysisData.lead_qualification || null,
    pain_points: JSON.stringify(analysisData.pain_points || []),
    objections: JSON.stringify(analysisData.objections || []),
    competitors_mentioned: JSON.stringify(analysisData.competitors_mentioned || []),
    next_steps: JSON.stringify(analysisData.next_steps || []),
    sentiment: analysisData.sentiment || null,
    key_quotes: JSON.stringify(analysisData.key_quotes || []),
    custom_fields: null,
  };
  insertAnalysis(analysisRow);

  const contentRaw = getTextFromMessage(contentResponse);
  const contentJson = contentRaw.trim().replace(/^```json\s*/i, "").replace(/\s*```\s*$/, "");
  const contentData = JSON.parse(contentJson || "{}");
  const ideas: ContentIdea[] = Array.isArray(contentData)
    ? contentData
    : contentData.ideas || contentData.content_ideas || [];

  const contentRows: ContentIdeaRow[] = [];
  for (const idea of ideas) {
    const ideaRow: Omit<ContentIdeaRow, "created_at"> = {
      id: uuid(),
      transcript_id: transcriptId,
      title: idea.title,
      type: idea.type,
      description: idea.description,
      target_audience: idea.target_audience || null,
      based_on: idea.based_on || null,
    };
    insertContentIdea(ideaRow);
    contentRows.push({ ...ideaRow, created_at: new Date().toISOString() });
  }

  const savedAnalysis = getAnalysisByTranscript(transcriptId)!;
  return { analysis: savedAnalysis, contentIdeas: contentRows };
}
