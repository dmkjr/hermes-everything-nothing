# Everything Nothing for Hermes

A community plugin with three tools for everyday writing and design.

- **Template Studio** saves reusable drafts with fields such as `{{recipient}}`. Fill the fields, check the preview, and copy the result.
- **Design Brief** turns a task and its constraints into a UI design brief. Pick a starting point and the checks to include, then copy the brief or a reusable `SKILL.md`.
- **Fluff Eater** sets a profile's default reply style. Choose Off, Light, Terse, or Fluff Eater. Explicit user instructions still take precedence. The style guidance asks Hermes to preserve facts, warnings, and code.

Requires Hermes 0.23.0 or newer. Enable the agent plugin and turn on its Desktop extension. In Desktop, open **Settings → Plugins → Everything Nothing**. Template Studio and Design Brief have their own pages. Set Fluff Eater under **Agent settings** for the selected profile. Use one response concision setting per profile if you also run a local Next Prompt fork.

Templates are stored on this device in Hermes Desktop plugin storage. The plugin writes to the clipboard when you use a Copy button. Fluff Eater adds fixed style instructions to the current interactive model turn. It makes no separate model call. The plugin makes no external network requests, starts no background processes, and reads no credentials or chat history.

Some code is derived from [Next Prompt](https://github.com/soymarketing/hermes-plugin-next-prompt), by soymarketing. This package provides writing and design tools under its own plugin ID. MIT licensed.
