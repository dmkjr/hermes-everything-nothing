# Everything Nothing for Hermes

![Hermes Everything Nothing](docs/media/everything-nothing-hero.png)

Next Prompt is the first feature in Everything Nothing. Its installed ID and
auxiliary model slot stay compatible with existing Hermes settings.

Next Prompt shows an editable reply preview in an empty Hermes Desktop composer.
Press **Right Arrow** to accept it into the draft. For a choice with multiple
options, press **Option+Left/Right** (Alt+Left/Right) to cycle before accepting.
Open the command palette to use or dismiss the current suggestion.

## Settings and diagnostics

Open **Settings → Plugins → Everything Nothing** for the active Hermes profile.
Turn off **Offer extra follow-up choices** to keep a single follow-up when
Hermes has not offered explicit choices. Selecting text in the composer or
editing and clearing the draft returns a cycled preview to the first option.

**Test Suggestion** runs a synthetic tea-or-coffee example on that profile.
It shows the actual provider and model when a model returns, plus the backend
elapsed time. Enable **Force offline fallback for this test** to bypass the
model call for just that run. The diagnostic does not modify the pending
suggestion store, chat history, or model settings.

## How suggestions work

The plugin extracts explicit choices from the assistant’s final message.
It constructs the replies itself and asks the configured model to rank them by
number. For other turns the configured Next Prompt model writes up to three
short questions grounded in the recent user requests and final assistant replies.
It can suggest a specific check, example, or next decision without assuming the
user has performed an action. The parser accepts bounded questions only and
rejects generic stock questions, completion claims, and malformed output.
Questions appear as previews; they are never sent automatically. Quoted choice
labels remain framed as preferences, including when they describe past actions.

The dependency-free local fallback offers detected choices in their original
order, a clarification for a question, or safe generic questions after a
substantial explanation if the model fails or cannot supply useful questions. It runs on
the Hermes backend and needs no model weights, network, or separate process.
Set `plugins.entries.next-prompt.settings.local_fallback` to false to disable
the fallback on model failure. Choice detection and follow-up templates are
currently English-oriented. The parser handles up to four explicit options.

## Choose the suggestion model

In Hermes Desktop, open **Settings → Models → Auxiliary → Next Prompt** for
the profile that runs the chat. Select a configured provider and model.
A local model already connected to that Hermes profile is available through
its configured provider. The default follows the main chat model.
You can also use `hermes model` → **Auxiliary** → **Next Prompt** or set
`auxiliary.next_prompt.provider` and `auxiliary.next_prompt.model` in that
profile's config. No separate plugin credentials are needed.

## Deployment

This fork retains the `next-prompt` plugin ID and the existing authenticated
REST route. Install the fork backend in the profile that runs chat turns
and its desktop bundle on the machine running Desktop. If the two are on
different machines, update both. Use a pinned revision of the fork when
distributing it. On Mac-2, the existing standalone desktop override must be
updated explicitly. A stock catalog update does not manage that override.

Reload the backend processes that run turns and serve plugin routes after
updating Python, then use **Reload desktop plugins** in Desktop. The database
upgrade adds one optional column and preserves existing rows. The fork
desktop suppresses pending replies produced by the old unrestricted generator.
Older desktops can still read the first suggestion from the fork backend.

The preview uses Hermes Desktop's composer markup, since the SDK does not
provide an inline preview slot. Insertion uses the SDK's composer API. This
local integration may need adjustment if Hermes changes its composer markup.

## Development

```sh
python -m unittest discover -s tests
node --test tests/frontend/plugin.test.mjs
```

MIT. Forked from [soymarketing/hermes-plugin-next-prompt](https://github.com/soymarketing/hermes-plugin-next-prompt).
