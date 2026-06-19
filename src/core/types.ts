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
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: "http://localhost:11434",
  apiKey: "",
  model: "llama3.1",
  temperature: 0,
  timeoutMs: 60000,
  maxBodyChars: 2000,
  concurrency: 1,
};

/** A compact, model-friendly summary of a single message. */
export interface MessageSummary {
  /** Thunderbird message id; opaque and only meaningful to the platform layer. */
  id: number;
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
