# dsh-granular-prompt

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin: inspect and steer prompt composition while it happens, with system
prompts and personas you author yourself.

**See every section the next request will send.** A Prompt tab inside
Granular Settings lists the live census of sections, each with suppress,
replace (from the scratchpad), view full text, and revert. Ship your own
system prompts (or take over the whole prompt in complete mode). Keep a
persona library and pick one per session, with a picker right beside the
chat input.

## What you get

- **Live list**: every section that will render in the next assembly, with
  a suppress checkbox, view, replace, and revert. Suppression and
  replacement are mutually exclusive per section.
- **System prompts**: a library plus an active selection, additive or
  complete mode. Complete makes your text the ENTIRE prompt
  (registry-enforced).
- **Personas**: a library with a global default and per-session selection;
  `inherit` falls back to the default.
- **Composer picker**: the same Active persona choice, one click from the
  chat input (togglable in the Plugin tab, default on).

## How to install

Requires a DeepSeek Harness checkout and a profile, here `web`. Clone the
dependencies and this plugin into a plugins folder:

```sh
mkdir -p ~/dsh-plugins && cd ~/dsh-plugins
git clone https://github.com/joao-paulo-santos/dsh-event-relay.git
git clone https://github.com/joao-paulo-santos/dsh-granular-settings.git
git clone https://github.com/joao-paulo-santos/dsh-granular-prompt.git

# from the harness checkout
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-event-relay
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-granular-settings
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-granular-prompt

# verify the profile still composes
pnpm dsh --profile web --dump-config
```

Restart the harness; the Prompt tab appears in Granular Settings.

## Mechanisms

- Census runs `systemPrompt.assemble` with a bypass marker its own
  waterfall listener honors, so the control surface always sees the
  UNFILTERED table.
- ONE waterfall listener applies suppress then replace, in that order;
  filter failures fall through unfiltered.
- The user system prompt (order -98) and persona (order 5) are registered
  sections with provider functions: switching applies to the NEXT request.
- Persona resolution: session setting, else default persona, else none.
- Store: `~/.dsh/settings/prompt-manager.json`, write-through memory with
  serialized writes.

## Debugging

The census behind the tab:

```
curl 'http://127.0.0.1:3080/granular-prompt/census'
curl 'http://127.0.0.1:3080/granular-prompt/census?session=<sid>'
```

## Dependencies

- [dsh-granular-settings](https://github.com/joao-paulo-santos/dsh-granular-settings) hosts the Prompt tab and owns the persona settings this plugin registers and reads
- [dsh-event-relay](https://github.com/joao-paulo-santos/dsh-event-relay) carries change doorbells (optional; focus refetch covers its absence)

## Plugins dependent on this

*(none)*
