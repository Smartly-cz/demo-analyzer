# Demo Analyzer

Analyze demo call transcripts from **Fathom** or **Granola** to understand leads better and generate content ideas.

## Features

- **Fathom integration** — connect to Fathom API to list and import calls directly
- **Transcript upload** — drag-and-drop file upload or paste text directly
- **Format detection** — auto-detects Fathom (.txt, .vtt) and Granola (.md) formats
- **AI-powered analysis** — lead scoring, pain points, objections, competitors, sentiment, key quotes
- **Content ideas** — generates blog posts, case studies, and other content ideas from real prospect conversations
- **REST API** — full API for programmatic access and integration

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env and add your OpenAI API key and Fathom API key

npm run build
npm start
# → http://localhost:3000
```

For development with hot reload:

```bash
npm run dev
```

## API

### Upload transcript (file)

```
POST /api/transcripts/upload
Content-Type: multipart/form-data

file: <transcript file (.txt, .md, .vtt, .srt, .json)>
title: (optional) override title
```

### Import transcript (text)

```
POST /api/transcripts
Content-Type: application/json

{
  "title": "Demo with Acme Corp",
  "text": "Speaker: Hello...",
  "source": "fathom",   // optional: "fathom", "granola", or auto-detect
  "date": "2026-01-15"  // optional
}
```

### List transcripts

```
GET /api/transcripts
```

### Get transcript

```
GET /api/transcripts/:id
```

### Analyze transcript

```
POST /api/transcripts/:id/analyze
```

Returns lead analysis + content ideas. Results are cached — subsequent calls return the same analysis.

### Get existing analysis

```
GET /api/transcripts/:id/analysis
```

### List all content ideas

```
GET /api/content-ideas
```

### Delete transcript

```
DELETE /api/transcripts/:id
```

## Fathom Integration

Set `FATHOM_API_KEY` in your `.env` file. Get your API key from the Fathom settings page.

### Check connection status

```
GET /api/fathom/status
→ { "connected": true }
```

### List recent calls from Fathom

```
GET /api/fathom/calls?created_after=2026-01-01T00:00:00Z&per_page=25&cursor=...
```

### Import a single Fathom call

```
POST /api/fathom/import/:recordingId
```

### Bulk import all calls

```
POST /api/fathom/import-all
Content-Type: application/json

{
  "created_after": "2026-01-01T00:00:00Z",  // optional
  "created_before": "2026-02-01T00:00:00Z"  // optional
}
```

## Supported Formats

| Source | Formats | Detection |
|--------|---------|-----------|
| Fathom | `.txt`, `.vtt` | Timestamped speaker lines (`00:01:23 Speaker: text`) |
| Granola | `.md` | Markdown with `# Title`, `**Attendees:**`, `## Transcript` sections |
| Plain text | `.txt`, `.srt` | Fallback — any text with `Speaker: text` lines |

## Tech Stack

- Node.js + Express + TypeScript
- SQLite (better-sqlite3) — zero-config, file-based database
- OpenAI API (gpt-4o-mini) for analysis
- Vanilla HTML/CSS/JS frontend
