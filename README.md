# SmarterMailSort

A Mozilla Thunderbird MailExtension that sorts mail folders using an
OpenAI-compatible LLM (OpenWebUI, Ollama, OpenAI) driven by natural-language
instructions — e.g. _"move items that are newsletters or notifications into the
`to_be_deleted` folder"_.

It is designed to be **safe on huge folders**: messages are streamed and
classified in configurable batches (and at configurable concurrency, serial by
default), the model only ever sees a compact summary of each email, and
**nothing is moved until you review and approve** the proposed changes.

## How it works

1. **Configure** an OpenAI-compatible endpoint and model in the extension's
   settings.
2. Open the sort tab either from the **SmarterMailSort** toolbar button (then
   pick a source folder), or by **right-clicking a folder → "Sort with
   SmarterMailSort…"** to open it with that folder preselected. Type an
   instruction.
3. **Classify** — the extension pages through the folder, builds a small summary
   per message (from/to, subject, a few headers, first _N_ body characters) and
   asks the model whether to keep it or move it to one of your **existing**
   folders. Progress is shown live, and you can **Stop & review** at any point
   to work with whatever has been classified so far (nothing is moved).
4. **Review** — proposed moves are grouped by destination folder with the
   model's reason and confidence. Deselect anything you disagree with.
5. **Apply** (or **dry-run**) — apply the selected moves, or download a
   human-readable Markdown report without changing anything.

The model can only target folders that already exist; it cannot create folders
in this version.

## Install (developer mode)

```bash
npm install
npm run build      # produces dist/
```

In Thunderbird: **Tools → Developer Tools → Debug Add-ons → Load Temporary
Add-on…** and select `dist/manifest.json`.

> Temporary add-ons are removed when Thunderbird restarts. For a persistent
> install, download the `.xpi` from the [Releases](../../releases) page and
> follow **[INSTALL.md](INSTALL.md)** (which also covers the unsigned-add-on
> signature setting).

## Configuration

Open the extension's settings (the **Settings** link in the tab, or
**Add-ons Manager → SmarterMailSort → Options**):

| Setting | Notes |
| --- | --- |
| Base URL | e.g. `http://localhost:11434` (Ollama), your OpenWebUI URL, or `https://api.openai.com`. `/v1/chat/completions` is appended automatically. |
| API key | Optional; sent only to your configured endpoint. |
| Model | e.g. `llama3.1`, `gpt-4o-mini`. |
| Temperature | `0` recommended for consistent classification. |
| Max body characters | How much body text the model sees per email. |
| Concurrency | `1` (serial) recommended for local models. |
| Emails per request | Batch size — classify several emails per LLM request. `1` keeps one request per email; higher values (≈10–20) are much faster on large folders if your model returns reliable JSON. |

Use **Test connection** to verify the endpoint before running a job.

### CORS / Ollama note

Thunderbird grants this extension privileged cross-origin access to your
endpoint host once you save settings (it requests permission for that origin).
The remaining gotcha is **Ollama**, which rejects cross-origin requests unless
started with its origins allow-list, e.g.:

```bash
OLLAMA_ORIGINS=* ollama serve
```

OpenWebUI and OpenAI require no extra configuration.

## Development

```bash
npm run watch      # rebuild dist/ on change
npm test           # unit tests (Vitest)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run lint:ext   # web-ext lint on dist/
npm run start      # launch Thunderbird with the extension loaded
```

The codebase separates **pure logic** (`src/core/*` — LLM client, prompt
building, message summarising, decision parsing, the classification loop) from
thin **platform wrappers** (`src/platform/*` — `messenger.*` access), so almost
everything is unit-tested in Node.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branching and release flow.

## Roadmap (possible v2)

- Create folders suggested by the model (needs the `accountsFolders` permission).
- Scheduled / automatic background sorting of incoming mail.
- Multi-account / multi-folder batch runs.
- Signed AMO release.
