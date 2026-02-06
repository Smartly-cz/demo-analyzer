export interface ParsedTranscript {
  title: string;
  source: "fathom" | "granola" | "unknown";
  date: string | null;
  participants: string[];
  text: string;
}

/**
 * Detect transcript source and parse accordingly.
 */
export function parseTranscript(filename: string, content: string): ParsedTranscript {
  const lower = filename.toLowerCase();

  if (isFathomFormat(content)) {
    return parseFathom(filename, content);
  }

  if (isGranolaFormat(content) || lower.endsWith(".md")) {
    return parseGranola(filename, content);
  }

  // VTT format (used by Fathom exports)
  if (lower.endsWith(".vtt") || content.trimStart().startsWith("WEBVTT")) {
    return parseVtt(filename, content);
  }

  return parsePlainText(filename, content);
}

/**
 * Fathom exports typically have a header section with meeting info
 * followed by timestamped speaker lines like:
 *   00:01:23 Speaker Name: text
 * or
 *   Speaker Name 00:01:23
 *   text
 */
function isFathomFormat(content: string): boolean {
  // Check for Fathom-style timestamped speaker lines
  const fathomPatterns = [
    /^\d{2}:\d{2}:\d{2}\s+.+:/m,
    /^Meeting\s+Recording/im,
    /fathom/i,
  ];
  return fathomPatterns.some((p) => p.test(content));
}

function parseFathom(filename: string, content: string): ParsedTranscript {
  const lines = content.split("\n");
  const participants = new Set<string>();
  const textLines: string[] = [];
  let title = extractTitleFromFilename(filename);
  let date: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try to extract date from common Fathom header formats
    const dateMatch = trimmed.match(
      /(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\w+ \d{1,2},?\s*\d{4})/
    );
    if (dateMatch && !date) {
      date = dateMatch[1];
    }

    // Title from first substantial line or "Meeting Recording:" prefix
    const titleMatch = trimmed.match(/^(?:Meeting\s+Recording[:\s]*)?(.+)$/i);
    if (titleMatch && lines.indexOf(line) < 3 && trimmed.length > 5) {
      title = titleMatch[1].trim();
    }

    // Timestamped speaker line: "00:01:23 Speaker Name: text"
    const speakerMatch = trimmed.match(
      /^(\d{2}:\d{2}:\d{2})\s+([^:]+):\s*(.*)$/
    );
    if (speakerMatch) {
      const speaker = speakerMatch[2].trim();
      participants.add(speaker);
      textLines.push(`${speaker}: ${speakerMatch[3]}`);
      continue;
    }

    // Alternative: "Speaker Name (00:01:23): text"
    const altMatch = trimmed.match(
      /^([^(]+)\s*\(\d{2}:\d{2}:\d{2}\)[:\s]*(.*)$/
    );
    if (altMatch) {
      const speaker = altMatch[1].trim();
      participants.add(speaker);
      textLines.push(`${speaker}: ${altMatch[2]}`);
      continue;
    }

    // Continuation text (no timestamp prefix)
    if (textLines.length > 0 && !trimmed.startsWith("#")) {
      textLines.push(trimmed);
    }
  }

  return {
    title,
    source: "fathom",
    date,
    participants: Array.from(participants),
    text: textLines.join("\n"),
  };
}

/**
 * Granola exports are markdown with a structure like:
 *  # Meeting Title
 *  **Date:** ...
 *  **Attendees:** ...
 *  ## Transcript
 *  Speaker: text
 */
function isGranolaFormat(content: string): boolean {
  const granolaPatterns = [
    /^#\s+.+/m,
    /granola/i,
    /\*\*(?:Attendees|Participants|Date)\*\*/i,
    /^##\s+(?:Transcript|Notes|Discussion)/im,
  ];
  let matches = 0;
  for (const p of granolaPatterns) {
    if (p.test(content)) matches++;
  }
  return matches >= 2;
}

function parseGranola(filename: string, content: string): ParsedTranscript {
  const lines = content.split("\n");
  const participants = new Set<string>();
  const textLines: string[] = [];
  let title = extractTitleFromFilename(filename);
  let date: string | null = null;
  let inTranscript = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Title from H1
    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) {
      title = h1[1].trim();
      continue;
    }

    // Date field
    const dateField = trimmed.match(
      /\*\*Date:?\*\*[:\s]*(.+)/i
    );
    if (dateField) {
      date = dateField[1].trim();
      continue;
    }

    // Attendees field
    const attendeesField = trimmed.match(
      /\*\*(?:Attendees|Participants):?\*\*[:\s]*(.+)/i
    );
    if (attendeesField) {
      const names = attendeesField[1].split(/[,;]/).map((n) => n.trim()).filter(Boolean);
      names.forEach((n) => participants.add(n));
      continue;
    }

    // Start of transcript section
    if (/^##\s+(?:Transcript|Discussion|Conversation)/i.test(trimmed)) {
      inTranscript = true;
      continue;
    }

    // Another H2 ends the transcript section
    if (inTranscript && /^##\s+/.test(trimmed)) {
      inTranscript = false;
      continue;
    }

    if (inTranscript && trimmed) {
      // Speaker line: "**Speaker Name:** text" or "Speaker Name: text"
      const speakerBold = trimmed.match(/^\*\*([^*:]+):?\*\*[:\s]*(.*)$/);
      const speakerPlain = trimmed.match(/^([A-Z][a-zA-Z\s]+):\s+(.+)$/);

      if (speakerBold) {
        participants.add(speakerBold[1].trim());
        textLines.push(`${speakerBold[1].trim()}: ${speakerBold[2]}`);
      } else if (speakerPlain) {
        participants.add(speakerPlain[1].trim());
        textLines.push(`${speakerPlain[1].trim()}: ${speakerPlain[2]}`);
      } else {
        textLines.push(trimmed);
      }
    }
  }

  // If we didn't find a transcript section, treat the whole content as text
  if (textLines.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("**")) {
        const speakerPlain = trimmed.match(/^([A-Z][a-zA-Z\s]+):\s+(.+)$/);
        if (speakerPlain) {
          participants.add(speakerPlain[1].trim());
        }
        textLines.push(trimmed);
      }
    }
  }

  return {
    title,
    source: "granola",
    date,
    participants: Array.from(participants),
    text: textLines.join("\n"),
  };
}

/**
 * Parse WebVTT subtitle format (Fathom video exports).
 */
function parseVtt(filename: string, content: string): ParsedTranscript {
  const participants = new Set<string>();
  const textLines: string[] = [];
  const title = extractTitleFromFilename(filename);

  const blocks = content.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip timing lines, WEBVTT header, and numeric cue IDs
      if (
        /^\d+$/.test(trimmed) ||
        /-->/.test(trimmed) ||
        trimmed === "WEBVTT" ||
        trimmed === ""
      ) {
        continue;
      }

      // Check for "Speaker: text" format
      const speakerMatch = trimmed.match(/^([^:]+):\s+(.+)$/);
      if (speakerMatch && speakerMatch[1].length < 40) {
        participants.add(speakerMatch[1].trim());
        textLines.push(`${speakerMatch[1].trim()}: ${speakerMatch[2]}`);
      } else {
        textLines.push(trimmed);
      }
    }
  }

  return {
    title,
    source: "fathom",
    date: null,
    participants: Array.from(participants),
    text: textLines.join("\n"),
  };
}

function parsePlainText(filename: string, content: string): ParsedTranscript {
  const participants = new Set<string>();
  const lines = content.split("\n");

  for (const line of lines) {
    const speakerMatch = line.trim().match(/^([A-Z][a-zA-Z\s]+):\s+/);
    if (speakerMatch && speakerMatch[1].length < 40) {
      participants.add(speakerMatch[1].trim());
    }
  }

  return {
    title: extractTitleFromFilename(filename),
    source: "unknown",
    date: null,
    participants: Array.from(participants),
    text: content,
  };
}

function extractTitleFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
