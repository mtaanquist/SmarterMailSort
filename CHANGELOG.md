# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Keep originals on cross-account moves (on by default).** When a proposed
  move targets a folder in a *different* account than the source, Thunderbird
  has to copy-then-delete (there is no atomic cross-account move), and an
  interrupted run can leave the source copy behind. A new **Keep originals for
  cross-account moves** toggle on the review screen — checked by default for
  safety — makes those cross-account transfers an explicit copy that leaves the
  original untouched; same-account destinations always move as before. Undo
  understands the difference: it moves real moves back and deletes the
  cross-account copies, restoring the exact pre-apply state. (Adds the
  `messagesDelete` permission, needed to remove the copies on undo.)

### Fixed
- **Large applies no longer abort after the first message.** Applying a big
  batch of moves (thousands of messages to one folder) issued a single
  `messages.move()` call, which Thunderbird's copy service aborts partway
  through with `onStopCopy` status `2153054241` (`0x80550021`) — only the first
  message moved and the rest failed. Moves are now split into sequential chunks
  of 100 with a short bounded retry per chunk (the folder is briefly "busy"
  between copies), so large applies complete and a transient hiccup no longer
  fails the whole run. Undo (move-back) is chunked the same way.

## [0.3.0] - 2026-06-19

### Added
- **Batched classification.** A new *Emails per request* (batch size) setting
  lets the model classify several emails in one LLM request instead of one
  request per email. On large folders this cuts round-trips and amortises the
  repeated prompt prefill, which is the main fix for slow runs on local models.
  Defaults to `1` (unchanged per-message behaviour); raise it (≈10–20 is a good
  start) when your model returns reliable JSON. The model returns one result
  per email keyed by id, so any email it reorders or omits safely defaults to
  "keep" for review.
- **Stop & review.** The classify button's companion (formerly "Stop") now
  reads *Stop & review* and reliably drops you into the review screen with
  everything classified so far — nothing is moved. The review header and the
  exported report note when a run was stopped early ("Stopped early — N of ~M
  classified").

## [0.2.5] - 2026-06-19

### Fixed
- Folder context-menu item ("Sort with SmarterMailSort…") did nothing when
  clicked. The handler required `info.selectedFolder.id` to be present, which
  isn't reliably populated; it now falls back to `displayedFolder` and always
  opens the sort tab (with the folder preselected when an id is available),
  logging a diagnostic when no folder id is found.

## [0.2.4] - 2026-06-19

### Fixed
- Folder picker is fixed properly. Enumeration now uses `folders.query({})`
  (one flat call for all folders), with a fallback that calls
  `getSubFolders(rootFolderId, true)` — the API takes a folder id **string**,
  not a folder object, which is why earlier attempts returned nothing — and a
  last-resort that exposes the root folder so the picker is never empty. The UI
  also now reports *why* the picker is empty instead of failing silently.
- Stopped the "closed conduit" console storm: the UI no longer reconnects its
  background port on a timer (which thrashed the suspending event page).
  It now connects lazily before each action, so a live job keeps the port
  alive and idle suspension is quiet.

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

[Unreleased]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mtaanquist/SmarterMailSort/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mtaanquist/SmarterMailSort/releases/tag/v0.1.0
