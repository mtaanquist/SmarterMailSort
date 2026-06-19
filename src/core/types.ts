// Pure data contracts shared across the extension. Nothing in this module
// touches the `messenger.*` WebExtension API, so it can be unit-tested freely.

/**
 * How to ask the endpoint to enforce JSON output. Endpoints differ: OpenAI and
 * Ollama accept `json_object`; LM Studio only accepts `json_schema` or plain
 * text. "auto" tries them in order and remembers what the endpoint accepts.
 */
export type ResponseFormat = "auto" | "json_object" | "json_schema" | "text";

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
  /**
   * OpenAI `frequency_penalty` (-2..2). A small positive value discourages a
   * model from degenerating into a repetition loop (the failure mode where it
   * rambles the same sentence until it exhausts the token budget). Keep it
   * modest: high values penalise the structural tokens valid JSON repeats
   * (especially in batch mode) and can corrupt the output. 0 omits the field.
   */
  frequencyPenalty: number;
  /**
   * Cap on response tokens (`max_tokens`). A classification decision is small,
   * so bounding the response stops a runaway generation from running until the
   * request times out. 0 means "automatic": a budget that scales with the batch
   * size (see resolveMaxTokens). A positive value is sent verbatim.
   */
  maxTokens: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** How to request JSON output; "auto" negotiates per endpoint. */
  responseFormat: ResponseFormat;
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
  frequencyPenalty: 0.3,
  maxTokens: 0,
  timeoutMs: 60000,
  responseFormat: "auto",
  maxBodyChars: 2000,
  concurrency: 1,
  batchSize: 1,
  maxRetries: 3,
  retryBaseMs: 500,
};

/** A named, reusable sort instruction the user can pick from a dropdown. */
export interface Preset {
  name: string;
  instruction: string;
}

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

/** One already-classified message, keyed by its move-stable RFC Message-ID. */
export interface CheckpointDecision {
  headerMessageId: string;
  decision: Decision;
}

/**
 * Incremental checkpoint of an in-progress classification run, persisted so a
 * run interrupted by event-page suspension or a restart can resume without
 * re-running the LLM over messages already decided. Intentionally small: it
 * stores decisions keyed by Message-ID, not full summaries.
 */
export interface JobCheckpoint {
  sourceFolderId: string;
  instruction: string;
  /** Whether this run may move into other accounts (so resume keeps the choice). */
  allowCrossAccount?: boolean;
  decisions: CheckpointDecision[];
}
