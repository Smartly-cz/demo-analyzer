/**
 * Fathom API client
 * Docs: https://developers.fathom.ai
 * Base URL: https://api.fathom.ai/external/v1
 * Auth: X-Api-Key header
 * Rate limit: 60 requests/minute
 */

const BASE_URL = "https://api.fathom.ai/external/v1";

export interface FathomConfig {
  apiKey: string;
}

// ── Response types ──────────────────────────────────────────────────

export interface FathomCalendarInvitee {
  name: string;
  email: string;
  email_domain: string;
  is_external: boolean;
  matched_speaker_display_name: string | null;
}

export interface FathomRecordedBy {
  name: string;
  email: string;
  email_domain: string;
  team: string | null;
}

export interface FathomTranscriptEntry {
  speaker: {
    display_name: string;
    matched_calendar_invitee_email: string | null;
  };
  text: string;
}

export interface FathomMeeting {
  title: string;
  meeting_title: string;
  recording_id: number;
  url: string;
  share_url: string;
  created_at: string;
  scheduled_start_time: string | null;
  scheduled_end_time: string | null;
  recording_start_time: string | null;
  recording_end_time: string | null;
  calendar_invitees_domains_type: string;
  transcript_language: string;
  calendar_invitees: FathomCalendarInvitee[];
  recorded_by: FathomRecordedBy;
  transcript?: FathomTranscriptEntry[];
  summary?: string;
  action_items?: string[];
}

export interface FathomListResponse {
  limit: number;
  next_cursor: string | null;
  items: FathomMeeting[];
}

export interface FathomTranscriptResponse {
  transcript: FathomTranscriptEntry[];
}

// ── Query parameters ────────────────────────────────────────────────

export interface ListMeetingsParams {
  created_after?: string;
  created_before?: string;
  recorded_by?: string[];
  teams?: string[];
  calendar_invitees?: string[];
  calendar_invitees_domains?: string[];
  include_transcript?: boolean;
  include_summary?: boolean;
  include_action_items?: boolean;
  include_crm_matches?: boolean;
  cursor?: string;
  per_page?: number;
}

// ── Client ──────────────────────────────────────────────────────────

export class FathomClient {
  private apiKey: string;

  constructor(config: FathomConfig) {
    this.apiKey = config.apiKey;
  }

  private async request<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
    const url = new URL(`${BASE_URL}${endpoint}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) {
            url.searchParams.append(`${key}[]`, String(v));
          }
        } else if (typeof value === "boolean") {
          url.searchParams.set(key, value ? "true" : "false");
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Api-Key": this.apiKey,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Fathom API error ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * List meetings with optional filters.
   * Returns paginated results (use cursor for next page).
   */
  async listMeetings(params?: ListMeetingsParams): Promise<FathomListResponse> {
    const queryParams: Record<string, any> = {};

    if (params) {
      if (params.created_after) queryParams.created_after = params.created_after;
      if (params.created_before) queryParams.created_before = params.created_before;
      if (params.recorded_by) queryParams.recorded_by = params.recorded_by;
      if (params.teams) queryParams.teams = params.teams;
      if (params.calendar_invitees) queryParams.calendar_invitees = params.calendar_invitees;
      if (params.calendar_invitees_domains) queryParams.calendar_invitees_domains = params.calendar_invitees_domains;
      if (params.include_transcript) queryParams.include_transcript = true;
      if (params.include_summary) queryParams.include_summary = true;
      if (params.include_action_items) queryParams.include_action_items = true;
      if (params.include_crm_matches) queryParams.include_crm_matches = true;
      if (params.cursor) queryParams.cursor = params.cursor;
      if (params.per_page) queryParams.per_page = params.per_page;
    }

    return this.request<FathomListResponse>("/meetings", queryParams);
  }

  /**
   * Fetch ALL meetings across all pages.
   */
  async getAllMeetings(params?: Omit<ListMeetingsParams, "cursor">): Promise<FathomMeeting[]> {
    const all: FathomMeeting[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.listMeetings({ ...params, cursor });
      all.push(...response.items);
      cursor = response.next_cursor || undefined;
    } while (cursor);

    return all;
  }

  /**
   * Get transcript for a specific recording.
   */
  async getTranscript(recordingId: number): Promise<FathomTranscriptResponse> {
    return this.request<FathomTranscriptResponse>(`/recordings/${recordingId}/transcript`);
  }

  /**
   * Get summary for a specific recording.
   */
  async getSummary(recordingId: number): Promise<{ summary: string }> {
    return this.request<{ summary: string }>(`/recordings/${recordingId}/summary`);
  }

  /**
   * Validate that the API key works by making a simple list request.
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.listMeetings({ per_page: 1 });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Convert Fathom transcript entries to plain text format.
 */
export function fathomTranscriptToText(entries: FathomTranscriptEntry[]): string {
  return entries
    .map((e) => `${e.speaker.display_name}: ${e.text}`)
    .join("\n");
}

/**
 * Extract unique participant names from Fathom meeting data.
 */
export function extractParticipants(meeting: FathomMeeting): string[] {
  const names = new Set<string>();

  // From calendar invitees
  for (const invitee of meeting.calendar_invitees || []) {
    if (invitee.name) names.add(invitee.name);
  }

  // From transcript speakers
  if (meeting.transcript) {
    for (const entry of meeting.transcript) {
      if (entry.speaker.display_name) names.add(entry.speaker.display_name);
    }
  }

  // From recorded_by
  if (meeting.recorded_by?.name) names.add(meeting.recorded_by.name);

  return Array.from(names);
}
