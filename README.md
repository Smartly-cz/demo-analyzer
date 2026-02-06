# Demo Analyzer

Analyze demo call transcripts from **Fathom** or **Granola** to understand leads better and generate content ideas.

## Features

- **Transcript upload** — drag-and-drop file upload or paste text directly
- **Format detection** — auto-detects Fathom (.txt, .vtt) and Granola (.md) formats
- **AI-powered analysis** — lead scoring, pain points, objections, competitors, sentiment, key quotes
- **Content ideas** — generates blog posts, case studies, and other content ideas from real prospect conversations
- **REST API** — full API for programmatic access and integration

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env and add your OpenAI API key

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
