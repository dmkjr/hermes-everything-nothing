# Everything Nothing for Hermes

One plugin for everyday writing, design, and faster replies in Hermes Desktop.

- **Template Studio** saves reusable drafts with fields such as `{{recipient}}`. Fill the fields, check the preview, and copy the result.
- **Design Brief** turns a task and its constraints into a UI design brief. Pick a starting point and the checks to include, then copy the brief or a reusable `SKILL.md`.
- **Fluff Eater** sets a profile's default reply style. Choose Off, Light, Terse, or Fluff Eater. Explicit user instructions still take precedence. The style guidance asks Hermes to preserve facts, warnings, and code.
- **Composer suggestions** preview an AI-generated follow-up as ghost text in the empty composer after each turn. Press Right Arrow to accept, Option+Left/Right to cycle ranked choices, or use the command palette / `mod+shift+y` keybind. Suggestions come from ranked choices in the agent's own reply; the model only ranks, it never invents reply text. If generation fails, a muted note says why.

Requires Hermes 0.23.0 or newer. Enable the agent plugin and turn on its Desktop extension. In Desktop, open **Settings → Plugins → Everything Nothing**: Template Studio, Design Brief, and Suggestions have their own pages, and the Suggestions page holds Fluff Eater and the suggestion settings for the active profile. The suggestion model can be pointed at a cheaper one under Settings → Auxiliary models → Next Prompt.

Templates are stored on this device in Hermes Desktop plugin storage; pending suggestions live in the plugin's SQLite store under its profile data directory. Copy buttons write to the clipboard. Fluff Eater adds fixed style instructions to the current interactive model turn. For suggestions, the plugin reads a clipped slice of recent chat messages and makes one auxiliary model call per turn (skipped when disabled or during cooldowns); it makes no external network requests beyond that model call, starts no background processes, and reads no credentials.

Some code is derived from [Next Prompt](https://github.com/soymarketing/hermes-plugin-next-prompt), by soymarketing. This package provides writing, design, and composer-suggestion tools under its own plugin ID. MIT licensed.

## Tests

```bash
python -m pytest tests/test_backend.py -q      # backend behaviour (hooks, store, REST)
node --test tests/frontend/                    # desktop plugin against a stub SDK
node tests/check_sdk_exports.mjs <hermes-agent checkout>   # SDK import names are real
hermes plugins validate .
```
