// Pure data contracts shared across the extension. Nothing in this module
// touches the `messenger.*` WebExtension API, so it can be unit-tested freely.

/** Configuration for the OpenAI-compatible LLM endpoint. */
export interface LlmConfig {
  /** Base URL, e.g. "http://localhost:11434" or "https://api.openai.com". */
  baseUrl: string;
  /** Optional bearer token. Empty string means no Authorization header. */
  apiKey: string;
  /** Model identifier passed to the endpoint. */
  model: string;
  /** Sampling temperature. Low values keep classification deterministic. */
  temperature: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

/** All persisted user settings. */
export interface Settings extends LlmConfig {
  /** Max number of body characters fed to the model per message. */
  maxBodyChars: number;
  /** How many messages to classify in parallel. 1 == strictly serial. */
  concurrency: number;
  /**
   * How many messages to classify per LLM request. 1 == one request per
   * message (legacy behaviour). Larger values amortise prompt prefill and cut
   * round-trips, at the cost of a longer per-request response.
   */
  batchSize: number;
  /**
   * How many times to retry a transient LLM failure (network/timeout/5xx/429)
   * before giving up on that request. 0 disables retrying.
   */
  maxRetries: number;
  /** Base delay for exponential backoff between retries, in milliseconds. */
  retryBaseMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: "http://localhost:11434",
  apiKey: "",
  model: "llama3.1",
  temperature: 0,
  timeoutMs: 60000,
  maxBodyChars: 2000,
  concurrency: 1,
  batchSize: 1,
  maxRetries: 3,
  retryBaseMs: 500,
};

/** A compact, model-friendly summary of a single message. */
export interface MessageSummary {
  /** Thunderbird message id; opaque and only meaningful to the platform layer. */
  id: number;
  /**
   * RFC Message-ID header. Unlike `id` (an internal tracking number that does
   * NOT survive a move to another folder), this is stable across moves, so it's
   * what the undo path uses to re-locate a message after it's been moved.
   */
  headerMessageId: string;
  author: string;
  recipients: string[];
  ccList: string[];
  subject: string;
  date: string;
  /** A small selection of raw headers worth showing the model. */
  headers: Record<string, string>;
  /** Truncated plain-text body. */
  bodyExcerpt: string;
}

/** A folder the model is allowed to target, identified by a human path. */
export interface FolderRef {
  /** Stable identifier used by the platform layer to perform the move. */
  id: string;
  /** Human-readable path, e.g. "Local Folders/to_be_deleted". */
  path: string;
}

/** A folder in the flattened tree, carrying depth for indented pickers. */
export interface FolderNode extends FolderRef {
  depth: number;
  accountName: string;
}

export type DecisionAction = "move" | "keep";

/** Normalised, validated decision for one message. */
export interface Decision {
  action: DecisionAction;
  /** Target folder path when action === "move"; null otherwise. */
  folder: string | null;
  reason: string;
  /** 0..1 model-reported confidence; defaults to 0 when absent. */
  confidence: number;
}

/** A decision tied back to the message it concerns. */
export interface ClassifiedMessage {
  summary: MessageSummary;
  decision: Decision;
  /** Set when classification failed for this message. */
  error?: string;
}

/** Progress callback payload emitted as classification proceeds. */
export interface ClassifyProgress {
  processed: number;
  total: number | null;
  lastResult?: ClassifiedMessage;
}

/** One moved message, identified by its move-stable RFC Message-ID. */
export interface UndoItem {
  headerMessageId: string;
  /** Folder the message was moved INTO (where undo must look for it now). */
  destFolderId: string;
}

/** The record needed to reverse the last applied batch of moves. */
export interface UndoRecord {
  /** Folder every message should be moved back to (the original source). */
  sourceFolderId: string;
  items: UndoItem[];
}

/** A message the undo could not move back, with why. */
export interface UndoFailure {
  headerMessageId: string;
  destFolderId: string;
  error: string;
}

/** Outcome of reversing an applied batch. */
export interface UndoOutcome {
  restored: number;
  failures: UndoFailure[];
}
