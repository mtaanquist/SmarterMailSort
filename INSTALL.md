# Installing SmarterMailSort in Thunderbird

Requires **Thunderbird 140 or newer** (matches the extension's
`strict_min_version`).

Grab `smartermailsort-<version>.xpi` from the
[Releases](../../releases) page, or build it yourself with
`npm install && npm run build && npm run package` (the `.zip` it produces in
`web-ext-artifacts/` can be renamed to `.xpi`).

There are two ways to install it. SmarterMailSort is **not signed**, which
affects how Thunderbird treats it.

## Option A — Permanent install (recommended for daily use)

Thunderbird won't install an unsigned add-on permanently unless signature
enforcement is disabled. Unlike Firefox release builds, Thunderbird honors this
preference:

1. **Settings → General →** scroll to the bottom **→ Config Editor…**
   (or open `about:config`).
2. Search for `xpinstall.signatures.required` and set it to **`false`**.
3. Open the **Add-ons Manager** (Tools → Add-ons and Themes).
4. Click the gear icon ⚙ → **Install Add-on From File…** and select the `.xpi`.

The add-on now persists across restarts.

> Trade-off: this disables signature checking for **all** add-ons globally. Only
> do this if you're comfortable with that. To undo it later, set
> `xpinstall.signatures.required` back to `true` (the unsigned add-on will then
> be disabled).

## Option B — Temporary install (developer mode)

No preference changes, but the add-on is removed when Thunderbird restarts.

1. **Tools → Developer Tools → Debug Add-ons.**
2. Click **Load Temporary Add-on…**
3. Select the `.xpi` file (or `dist/manifest.json` from a local build).

## After installing

Open the **SmarterMailSort** toolbar button, then configure your LLM endpoint
via the **Settings** link (or Add-ons Manager → SmarterMailSort → Options)
before running a sort. See the [README](README.md) for usage and the
Ollama/CORS note.
