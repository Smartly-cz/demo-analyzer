import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuid } from "uuid";
import {
  insertAnalysis,
  insertContentIdea,
  getAnalysisByTranscript,
  getContentIdeasByTranscript,
  deleteAnalysisByTranscript,
  getAnalysisWithTranscript,
  getLatestAggregateReport,
  insertAggregateReport,
  getLatestPatternReport,
  insertPatternReport,
  getAnalysesHash,
  listAllAnalyses,
  listContentIdeas,
  AnalysisRow,
  ContentIdeaRow,
  AggregateReportRow,
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
  feature_requests: string[];
  decision_process: {
    decision_makers: string[];
    timeline: string;
    budget_mentioned: string;
    process_notes: string;
  };
  buying_triggers: string[];
  current_tools: string[];
  use_cases: string[];
  company_signals: {
    industry: string;
    team_size: string;
    growth_stage: string;
    metrics_mentioned: string[];
  };
  commitment_signals: { quote: string; signal_strength: string }[];
  prospect_questions: string[];
}

export interface ContentIdea {
  title: string;
  type: string;
  description: string;
  target_audience: string;
  based_on: string;
}

const ANALYSIS_SYSTEM = `You are an expert sales analyst and market researcher. Analyze demo call transcripts and provide a comprehensive structured analysis covering sales signals, product intelligence, and buyer profile. Always respond with valid JSON only, no markdown or extra text.`;

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
- "feature_requests": Array of features, capabilities, or integrations the prospect asked about or wished existed (e.g. "Can it do X?", "We'd need Y", "Does it integrate with Z?")
- "decision_process": Object with { "decision_makers": string[] (people mentioned who influence the decision), "timeline": string (any timeline mentioned, e.g. "Q2 evaluation", "Need by March", or "No timeline mentioned"), "budget_mentioned": string (any budget signals, e.g. "$50k range", "Need to stay under current spend", or "Not discussed"), "process_notes": string (how they buy — e.g. "Needs legal review", "Committee decision", "POC required first") }
- "buying_triggers": Array of urgency signals — why are they looking now? (e.g. "Contract renewal in 60 days", "New VP mandate", "Scaling from 10 to 50 reps", "Current tool sunsetting")
- "current_tools": Array of tools, platforms, or systems they currently use (CRM, analytics, competitors, adjacent tools — anything mentioned)
- "use_cases": Array of specific jobs-to-be-done or workflows they want to accomplish (not symptoms/pain points, but the actual outcomes and workflows, e.g. "Automate lead scoring across 3 regions", "Replace manual reporting with real-time dashboards")
- "company_signals": Object with { "industry": string (or "Unknown"), "team_size": string (any team/company size mentioned, or "Unknown"), "growth_stage": string (e.g. "Series B startup", "Enterprise", "Growing rapidly", or "Unknown"), "metrics_mentioned": string[] (any numbers they shared — revenue, headcount, deal volume, conversion rates, etc.) }
- "commitment_signals": Array of objects { "quote": string (what they said), "signal_strength": "Strong"/"Moderate"/"Weak" }. Look for intent language: "We want to move forward" (Strong), "This looks promising" (Moderate), "We'll think about it" (Weak). Include 2-5 signals.
- "prospect_questions": Array of questions the prospect asked during the call. These reveal what matters to them and what's unclear — different from objections.

Be specific and reference actual content from the transcript. If a field has no data, use an empty array or appropriate default.

TRANSCRIPT:
`;

const CONTENT_IDEAS_SYSTEM = `You are a B2B content marketing and personal branding strategist. Based on demo call transcripts, suggest content ideas that would resonate with similar prospects. Include ideas for personal LinkedIn presence (posts and articles) and newsletter content — these are powerful channels for thought leadership and nurturing leads. Always respond with valid JSON only: either a JSON array of 3-5 content ideas, or a single object with an "ideas" or "content_ideas" array. No markdown or extra text.`;

const CONTENT_IDEAS_USER_PREFIX = `Return a JSON array of 3-5 content ideas. Each idea should be a JSON object with:
- "title": A compelling title for the content piece
- "type": One of "Blog Post", "Case Study", "Whitepaper", "Video", "Webinar", "LinkedIn Post", "LinkedIn Article", "Newsletter", "Email Sequence", "FAQ", "Comparison Guide"
- "description": 2-3 sentences describing the content and angle
- "target_audience": Who this content is for
- "based_on": What specific part of the conversation inspired this idea

Focus on pain points, objections, and questions that came up. These are real signals from real prospects.
Always include at least one LinkedIn content idea (Post or Article) and one Newsletter idea. LinkedIn posts should be concise thought-leadership takes; LinkedIn articles should be deeper dives. Newsletter ideas should be value-packed content that nurtures leads over time.

TRANSCRIPT:
`;

export async function analyzeTranscript(
  transcriptId: string,
  transcriptText: string,
  force: boolean = false
): Promise<{ analysis: AnalysisRow; contentIdeas: ContentIdeaRow[] }> {
  // Check for existing analysis (skip if force re-analyze)
  if (!force) {
    const existing = getAnalysisByTranscript(transcriptId);
    if (existing) {
      const ideas = getContentIdeasByTranscript(transcriptId);
      return { analysis: existing, contentIdeas: ideas };
    }
  } else {
    // Delete old analysis and content ideas before re-analyzing
    deleteAnalysisByTranscript(transcriptId);
  }

  const client = getClaude();

  // Run analysis and content ideas in parallel (Claude for deep research on calls)
  const [analysisResponse, contentResponse] = await Promise.all([
    client.messages.create({
      model: getModel(),
      max_tokens: 8192,
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
    feature_requests: JSON.stringify(analysisData.feature_requests || []),
    decision_process: JSON.stringify(analysisData.decision_process || {}),
    buying_triggers: JSON.stringify(analysisData.buying_triggers || []),
    current_tools: JSON.stringify(analysisData.current_tools || []),
    use_cases: JSON.stringify(analysisData.use_cases || []),
    company_signals: JSON.stringify(analysisData.company_signals || {}),
    commitment_signals: JSON.stringify(analysisData.commitment_signals || []),
    prospect_questions: JSON.stringify(analysisData.prospect_questions || []),
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

// ═══════════════════════════════════════════════════════════════════
// Aggregate Cross-Call Analysis
// ═══════════════════════════════════════════════════════════════════

export interface AggregateReport {
  pipeline_summary: {
    total_calls: number;
    hot_leads: number;
    warm_leads: number;
    cold_leads: number;
    avg_lead_score: number;
  };
  top_pain_points: { pain_point: string; frequency: number; example_quotes: string[] }[];
  top_objections: { objection: string; frequency: number; suggested_response: string }[];
  competitor_landscape: { competitor: string; mentions: number; context: string }[];
  trending_themes: { theme: string; description: string; relevance: string }[];
  content_recommendations: { title: string; type: string; description: string; priority: string; based_on_signals: string }[];
  top_feature_requests: { feature: string; frequency: number; context: string }[];
  tool_landscape: { tool: string; mentions: number; category: string }[];
  buyer_profile: { dimension: string; insight: string }[];
  executive_summary: string;
  recommendations: string[];
}

const AGGREGATE_SYSTEM = `You are a senior sales and marketing strategist. You will receive structured data from multiple demo call analyses. Synthesize these into an executive-level cross-call report identifying patterns, trends, and actionable insights. Always respond with valid JSON only, no markdown or extra text.`;

const AGGREGATE_USER_PREFIX = `Analyze the following data from multiple demo calls. Return a JSON object with:

- "pipeline_summary": { "total_calls": number, "hot_leads": number, "warm_leads": number, "cold_leads": number, "avg_lead_score": number }
- "top_pain_points": Array of { "pain_point": string, "frequency": number (how many calls mentioned it), "example_quotes": string[] }. Ranked by frequency, max 8.
- "top_objections": Array of { "objection": string, "frequency": number, "suggested_response": string (a recommended way to handle this objection) }. Max 6.
- "competitor_landscape": Array of { "competitor": string, "mentions": number, "context": string (why prospects bring them up) }. Max 6.
- "trending_themes": Array of { "theme": string, "description": string, "relevance": string (why this matters for your product/sales strategy) }. Identify 3-5 themes.
- "content_recommendations": Array of { "title": string, "type": string (Blog Post/Case Study/Whitepaper/Video/Webinar/LinkedIn Post/LinkedIn Article/Newsletter/Comparison Guide), "description": string, "priority": "High"/"Medium"/"Low", "based_on_signals": string }. Top 5-8 ideas ranked by potential impact.
- "top_feature_requests": Array of { "feature": string, "frequency": number, "context": string (why prospects want this) }. Ranked by frequency, max 8. Consolidate similar requests.
- "tool_landscape": Array of { "tool": string, "mentions": number, "category": string (e.g. "CRM", "Analytics", "Competitor", "Communication") }. What tools prospects currently use. Max 10.
- "buyer_profile": Array of { "dimension": string, "insight": string }. Synthesize company_signals, decision_process, and buying_triggers across calls into a composite buyer profile. Include dimensions like: typical industry, company size, growth stage, buying timeline, decision process, budget signals. 5-8 dimensions.
- "executive_summary": A 3-5 sentence strategic summary of what these calls tell you about your market position, ideal customer profile, and biggest opportunities.
- "recommendations": Array of 3-5 actionable next-step recommendations for the sales and marketing team.

Be specific — reference actual data patterns. Group similar pain points and objections into canonical themes rather than listing duplicates.

CALL ANALYSES DATA:
`;

export async function generateAggregateReport(
  force: boolean = false
): Promise<{ report: AggregateReport; cached: boolean; analyses_count: number }> {
  const currentHash = getAnalysesHash();
  const analysesData = getAnalysisWithTranscript();

  if (analysesData.length === 0) {
    throw new Error("No analyzed transcripts yet. Analyze at least one transcript first.");
  }

  // Check cache
  if (!force) {
    const existing = getLatestAggregateReport();
    if (existing && existing.analyses_hash === currentHash) {
      return {
        report: JSON.parse(existing.report),
        cached: true,
        analyses_count: existing.analyses_count,
      };
    }
  }

  // Build structured input from all analyses
  const callSummaries = analysesData.map((row, i) => {
    const a = row.analysis;
    return {
      call_number: i + 1,
      title: row.title,
      date: row.date,
      participants: row.participants,
      lead_score: a.lead_score,
      lead_qualification: a.lead_qualification,
      sentiment: a.sentiment,
      summary: a.summary,
      pain_points: safeParseJson(a.pain_points),
      objections: safeParseJson(a.objections),
      competitors_mentioned: safeParseJson(a.competitors_mentioned),
      next_steps: safeParseJson(a.next_steps),
      key_quotes: safeParseJson(a.key_quotes),
      feature_requests: safeParseJson(a.feature_requests),
      decision_process: safeParseJson(a.decision_process),
      buying_triggers: safeParseJson(a.buying_triggers),
      current_tools: safeParseJson(a.current_tools),
      use_cases: safeParseJson(a.use_cases),
      company_signals: safeParseJson(a.company_signals),
      commitment_signals: safeParseJson(a.commitment_signals),
      prospect_questions: safeParseJson(a.prospect_questions),
    };
  });

  const client = getClaude();

  const response = await client.messages.create({
    model: getModel(),
    max_tokens: 8192,
    system: AGGREGATE_SYSTEM,
    messages: [
      {
        role: "user",
        content: AGGREGATE_USER_PREFIX + JSON.stringify(callSummaries, null, 2),
      },
    ],
    temperature: 0.4,
  });

  const raw = getTextFromMessage(response);
  const report: AggregateReport = JSON.parse(
    raw.trim().replace(/^```json\s*/i, "").replace(/\s*```\s*$/, "") || "{}"
  );

  // Cache it
  const id = uuid();
  insertAggregateReport({
    id,
    analyses_hash: currentHash,
    analyses_count: analysesData.length,
    report: JSON.stringify(report),
  });

  return { report, cached: false, analyses_count: analysesData.length };
}

function safeParseJson(val: string | null): any {
  if (!val) return [];
  try { return JSON.parse(val); } catch { return val; }
}

// ═══════════════════════════════════════════════════════════════════
// Pattern Detection — cluster similar items across calls
// ═══════════════════════════════════════════════════════════════════

export interface PatternReport {
  pain_points: PatternCluster[];
  objections: PatternCluster[];
  feature_requests: PatternCluster[];
  use_cases: PatternCluster[];
  buying_triggers: PatternCluster[];
  prospect_questions: PatternCluster[];
  content_ideas: ContentCluster[];
}

export interface PatternCluster {
  canonical: string;
  count: number;
  variants: string[];
  calls: string[];
}

export interface ContentCluster {
  canonical_title: string;
  type: string;
  count: number;
  variants: { title: string; description: string }[];
}

const PATTERN_SYSTEM = `You are a data analyst specializing in clustering and deduplication. You will receive arrays of free-text items extracted from multiple demo call analyses. Many items mean the same thing but are worded differently. Your job is to group them into canonical clusters. Always respond with valid JSON only, no markdown or extra text.`;

const PATTERN_USER_PREFIX = `I have items extracted from multiple demo call analyses. Many items refer to the same concept but are phrased differently.

For each category, cluster the items into groups of similar meaning. Return a JSON object with:

- "pain_points": Array of { "canonical": string (short, canonical name for this cluster), "count": number (total occurrences), "variants": string[] (all original wordings), "calls": string[] (transcript titles where this appeared) }
- "objections": Same structure
- "feature_requests": Same structure
- "use_cases": Same structure
- "buying_triggers": Same structure
- "prospect_questions": Same structure
- "content_ideas": Array of { "canonical_title": string (best representative title), "type": string (content type), "count": number (how many similar ideas), "variants": [{ "title": string, "description": string }] }

Rules:
- Be aggressive about merging — if two items mean roughly the same thing, cluster them together
- "Manual reporting" and "Reports take too long" = same cluster
- "Need Salesforce integration" and "Does it integrate with Salesforce?" = same cluster
- The "canonical" name should be the clearest, most descriptive version
- Sort clusters by count (highest first)
- Items that are truly unique should be their own cluster with count=1

DATA:
`;

export async function generatePatternReport(
  force: boolean = false
): Promise<{ report: PatternReport; cached: boolean; analyses_count: number }> {
  const currentHash = getAnalysesHash();
  const analyses = listAllAnalyses();

  if (analyses.length === 0) {
    throw new Error("No analyzed transcripts yet. Analyze at least one transcript first.");
  }

  // Check cache
  if (!force) {
    const existing = getLatestPatternReport();
    if (existing && existing.analyses_hash === currentHash) {
      return {
        report: JSON.parse(existing.report),
        cached: true,
        analyses_count: existing.analyses_count,
      };
    }
  }

  // Collect all raw items from analyses, tracking which call they came from
  const allData: Record<string, { items: string[]; callTitle: string }[]> = {
    pain_points: [],
    objections: [],
    feature_requests: [],
    use_cases: [],
    buying_triggers: [],
    prospect_questions: [],
  };

  // We need transcript titles — get analyses with transcript info
  const analysesWithTranscripts = getAnalysisWithTranscript();

  for (const row of analysesWithTranscripts) {
    const a = row.analysis;
    const title = row.title;
    for (const field of Object.keys(allData)) {
      const raw = (a as any)[field];
      const items: string[] = safeParseJson(raw);
      if (Array.isArray(items) && items.length > 0) {
        allData[field].push({ items, callTitle: title });
      }
    }
  }

  // Also collect content ideas
  const contentIdeas = listContentIdeas();
  const contentInput = contentIdeas.map(c => ({
    title: c.title,
    type: c.type,
    description: c.description,
  }));

  // Build the input for the AI
  const clusterInput: Record<string, { item: string; call: string }[]> = {};
  for (const [field, entries] of Object.entries(allData)) {
    clusterInput[field] = [];
    for (const entry of entries) {
      for (const item of entry.items) {
        clusterInput[field].push({ item, call: entry.callTitle });
      }
    }
  }

  const inputPayload = {
    ...clusterInput,
    content_ideas: contentInput,
  };

  const client = getClaude();
  const response = await client.messages.create({
    model: getModel(),
    max_tokens: 8192,
    system: PATTERN_SYSTEM,
    messages: [
      {
        role: "user",
        content: PATTERN_USER_PREFIX + JSON.stringify(inputPayload, null, 2),
      },
    ],
    temperature: 0.2,
  });

  const raw = getTextFromMessage(response);
  const report: PatternReport = JSON.parse(
    raw.trim().replace(/^```json\s*/i, "").replace(/\s*```\s*$/, "") || "{}"
  );

  // Cache it
  const id = uuid();
  insertPatternReport({
    id,
    analyses_hash: currentHash,
    analyses_count: analyses.length,
    report: JSON.stringify(report),
  });

  return { report, cached: false, analyses_count: analyses.length };
}
