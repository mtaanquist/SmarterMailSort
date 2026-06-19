# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.4] - 2026-06-19

### Fixed
- Folder picker could be completely empty (regression in 0.2.3). Folder
  enumeration now tries multiple `getSubFolders` argument shapes, degrades to
  the account's inline folders, and finally exposes the root folder itself, so
  the picker is never silently empty. Diagnostic warnings are logged if no
  folders are found.

## [0.2.3] - 2026-06-19

### Fixed
- Folder picker only listed account root folders, not the folders inside them.
  `accounts.list()` doesn't populate the nested `subFolders` tree in MV3, so
  the hierarchy is now fetched explicitly via `folders.getSubFolders(root,
  true)` (with a fallback to any folders the account already carried).
- UI now reconnects its background port if the event page suspends (the source
  of the harmless "closed conduit" console warning), and ignores a respawned
  empty state so a review in progress isn't wiped from the screen.

## [0.2.2] - 2026-06-19

### Fixed
- Clicking the toolbar button (and the folder context menu) failed to open the
  app: `openApp` queried tabs by URL, which requires the broad `tabs`
  permission we intentionally don't request. Now tracks its own tab id
  (via `tabs.get`/`create`/`update`, no extra permission) and clears it on
  `tabs.onRemoved`.

## [0.2.1] - 2026-06-19

### Fixed
- **Settings now actually save.** The manifest used the MV2 `browser_action`
  key, which Thunderbird MV3 ignores — leaving `messenger.browserAction`
  undefined, so the background script threw on load and never registered its
  message handler (every settings save failed with "Receiving end does not
  exist"). Switched to the MV3 `action` key/API.
- Entry-point registration (toolbar button, folder menu) is now wrapped in
  try/catch and runs after the message handler is installed, so a future API
  quirk can't take down settings/UI messaging.

## [0.2.0] - 2026-06-19

### Added
- **Right-click a folder → "Sort with SmarterMailSort…"** in the folder pane,
  which opens the sort tab with that folder preselected (in addition to the
  toolbar button). Adds the `menus` permission.

### Fixed
- Saving settings no longer blanks the form: the endpoint host permission was
  built from a match pattern containing a port, which is invalid and threw,
  aborting the save before settings were persisted.

## [0.1.0] - 2026-06-19

Initial release.

### Added
- Sort a mail folder with a natural-language instruction using an
  OpenAI-compatible LLM endpoint (OpenWebUI, Ollama, or OpenAI).
- Streaming, paginated classification of large folders with configurable
  concurrency (serial by default), live progress, and cancellation.
- **Classify → review → apply** safety model: the model proposes moves into
  existing folders; you review and approve before anything is moved.
- Dry-run mode that produces a human-readable Markdown report instead of
  moving mail.
- Dedicated tab UI (folder picker, progress, grouped review table) and an
  options page for endpoint/model settings with a connection test.
- Cross-origin access handled via `optional_host_permissions` requested at
  runtime; documented Ollama `OLLAMA_ORIGINS` requirement.
- Release packaging that attaches both `.zip` and `.xpi` artifacts to the
  GitHub Release, plus an `INSTALL.md` covering signed/temporary installation.

[Unreleased]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mtaanquist/SmarterMailSort/releases/tag/v0.1.0
