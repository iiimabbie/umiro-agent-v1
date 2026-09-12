<div align="center">

<img src="assets/umiro-header.png" alt="Umiro" width="700">

**English** · [繁體中文](README.zh-TW.md)

**A self-hosted personal AI assistant for Discord and the terminal.**

[![version](https://img.shields.io/badge/version-0.1.0-blue)](package.json)
[![node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

</div>

> [!IMPORTANT]
> **This generation of ümiro is no longer maintained.** Development continues in [umiro-agent](https://github.com/iiimabbie/umiro-agent), a ground-up rewrite with a durable execution core, SQLite-backed conversations and a plugin system. This repository stays available for reference only.

Umiro runs a protocol-neutral agent loop through configurable LLM connection profiles, gives it a local workspace and tools, and keeps the assistant useful across conversations — without giving up control of where its data lives.

> [!WARNING]
> Umiro can execute shell commands and access connected services. Run it only on infrastructure and Discord servers you trust, and review its configuration before enabling it for other people.

## Features

| | |
|---|---|
| **Two front ends** | Discord (mentions, owner DMs, ambient channels) and an interactive local CLI |
| **Durable context** | Per-channel sessions, archived conversations, daily and long-term memory |
| **Workspace-first** | Persona, instructions, people records, skills, memories, and generated files all live under `workspace/` |
| **Tools** | Files, shell, Discord moderation and messaging, scheduled jobs, reminders, weather, and Google Calendar / Gmail / Drive / Tasks |
| **Extensible** | Installable workspace skills and local private plugins |
| **Guarded** | Soul Guardian integrity monitoring on protected workspace files |
| **Readable logs** | One file per local day — `logs/umiro-YYYY-MM-DD.log` |

For architecture and data flow, see [docs/DESIGN.md](docs/DESIGN.md). Tool activity phrase libraries are documented in [docs/TOOL_ACTIVITY.md](docs/TOOL_ACTIVITY.md). To build a private tool integration, see [docs/PLUGINS.md](docs/PLUGINS.md).

## Requirements

- Node.js 24 or newer, and npm
- An OpenAI API key, or a compatible endpoint implementing `POST /v1/chat/completions` or `POST /v1/responses` with function calling
- A Discord application token, if you want the Discord front end
- Linux with systemd — optional, but recommended for running the gateway as a service

## Quick start

```bash
git clone <repo-url> ~/.umiro
cd ~/.umiro

# Installs dependencies, creates local templates, registers `umiro`,
# and installs a systemd service when the host supports it.
npx tsx bin/umiro.ts install

# Fill in credentials and runtime settings.
$EDITOR .env
$EDITOR config.yaml

# Save your Discord user ID and, optionally, a first allowed channel.
umiro onbord

# Start the gateway in the foreground.
umiro gateway
```

`umiro install` never overwrites existing configuration or workspace files, so it is safe to re-run.

> [!NOTE]
> Run `umiro onbord` locally before the first Discord use. It writes `discord.owner_id` rather than trusting the first user the gateway sees. The owner's preferred form of address and the assistant persona are collected privately in the first Discord conversation.

## Configuration

### `.env` — credentials

```dotenv
# Required for model access
LLM_API_KEY=
# Empty uses https://api.openai.com/v1; otherwise an OpenAI-compatible `/v1` base URL.
LLM_BASE_URL=

# Required only when Discord is enabled
DISCORD_TOKEN=

# Optional: semantic memory recall with Gemini embeddings
GOOGLE_API_KEY=

# Optional: Google Calendar, Gmail, Drive, and Tasks tools
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

> [!CAUTION]
> Never commit `.env`, `config.yaml`, or `workspace/`. They are ignored by default because they hold secrets and private assistant data.

### `config.yaml` — behavior and access

Start from `config.example.yaml`. The settings worth reviewing before the first launch:

```yaml
timezone: "Asia/Taipei"

llm:
  active_profile: "local-gateway"
  maxContextTokens: 150000
  memoryCharLimit: 3000
  profiles:
    local-gateway:
      protocol: "openai_chat_completions"
      baseUrl: "${LLM_BASE_URL}"
      apiKey: "${LLM_API_KEY}"
      auth: "bearer"
      model: "claude-sonnet-4-6"
      reasoningEffort: "default"
      tokenLimitField: "max_completion_tokens"
      capabilities:
        vision: true
        function_tools: true
        responses: true
        hosted_web_search: true
        hosted_image_generation: true
        hosted_code_execution: false
```

`timezone` drives timestamps, memory filenames, and journal dates. Leaving it empty uses the host timezone.

**Connection profiles.** The active profile independently selects the wire protocol, gateway URL, authentication, default model ID, token-limit field, and hosted capabilities. A new channel session snapshots that profile's model and reasoning effort. `/model` changes only the current Discord channel, thread, or DM; its model, reasoning effort, and queue choice persist across `/new` and daily journal archiving, while other channels, threads, DMs, CLI sessions, and background sessions keep their own selection.

Model IDs are discovered from the session's endpoint through `GET /models`, never duplicated in config; manually entered IDs stay allowed for compatible servers that omit aliases from discovery. The supported interactive adapters are `openai_chat_completions` and `openai_responses`. Both target their standard OpenAI-compatible contracts rather than any one gateway implementation, support bearer-authenticated and trusted unauthenticated endpoints, and keep provider-specific extensions behind explicit profile capabilities. Hosted Responses capabilities are exposed only when the active profile declares them — Umiro never silently switches profile or model.

## Running

| | |
|---|---|
| `umiro gateway` | Foreground gateway, for development or hosts without systemd |
| `umiro` | Interactive local CLI — `new` archives the conversation, `exit` leaves |
| `sudo systemctl {start,stop,restart,status} umiro` | Service control |
| `journalctl -u umiro -f` | Follow service output |

The installer creates `umiro.service` only on Linux hosts where systemd is detected. After customizing the unit file, run `sudo systemctl daemon-reload` before restarting.

### Logs

Application logs go to `logs/umiro-YYYY-MM-DD.log`, one file per local day. A new file starts at local midnight without restarting the gateway, and existing files are appended to, never overwritten.

```text
[2026-08-21 09:04:52] INFO: discord trigger {"sessionId":"...","author":"owner"}
```

`LOG_LEVEL` controls verbosity. The default is `debug`; use `info` in routine operation if you do not need tool-level diagnostics.

```bash
LOG_LEVEL=info umiro gateway
```

## Discord

Umiro responds when mentioned, and can reply without a mention in the channel IDs listed under `discord.ambient_channels`. Threads do not inherit ambient behavior from their parent channel.

| Command | | |
|---|---|---|
| `/new` | Archive the channel session and start a new conversation | |
| `/status` | Model, session, token, and active-run information | |
| `/stop` | Stop the active run in the current session | run initiator or owner |
| `/queue` | Set `followup` / `steer` handling for the current session, or reset to the global default | |
| `/compact` | Summarize older context, retaining recent messages | |
| `/task` | List Google Tasks | |
| `/model` | Switch the session's model and reasoning effort | owner only |
| `/google-auth` | Finish Google OAuth authorization | owner only |
| `/restart` | Exit the gateway so its process manager restarts it | owner only |
| `/plugin` | Install, update, or uninstall a plugin | owner only |

## Workspace

`workspace/` is Umiro's private runtime area. `umiro install` creates the prompt templates; the agent maintains everything else.

```text
workspace/
├── AGENT.md            # Operating rules and tool behavior
├── SOUL.md             # Persona and voice
├── OWNER.md            # Owner profile: identity, permissions, accounts, work, relationships
├── PEOPLE.md           # Profiles for everyone except the owner
├── MEMORY.md           # Long-lived non-profile operating context
├── JOURNAL.md          # Daily-memory and journal prompts
├── attachments/        # Generated and downloaded files
├── config/             # SQLite DB, cron/reminder data, OAuth tokens
├── memory/             # Daily memory files
├── sessions/           # Active sessions and archived conversations
└── skills/             # Installed skills
```

> [!IMPORTANT]
> Keep this directory private and back it up. It holds conversation history, OAuth tokens, uploaded files, and personal notes.

## Security model

Umiro is built for a personal, trusted deployment — not as a sandboxed public bot.

- `bash` runs arbitrary host commands without a sandbox. With `tools.bash_owner_only: true` (the default), only the configured owner and IDs in `bash_allowed_users` can call it.
- High-impact tools — Gmail, Drive, Calendar, scheduling, and Discord message mutation — are owner-only.
- Use `discord.allowed_guilds` and `discord.allowed_channels` to minimize where the bot can be triggered.
- Treat `workspace/config/google-token.json`, `.env`, and all log and workspace data as private.
- Review every third-party skill before installing it. A skill can add instructions that influence tool use.

## Google integration

1. Create a Google Cloud project.
2. Enable the Calendar, Gmail, Drive, and Tasks APIs.
3. Create a Desktop OAuth client.
4. Put its client ID and secret in `.env`.
5. Restart Umiro and run `/google-auth` as the owner.

`GOOGLE_API_KEY` is separate — it powers only Gemini embedding-based semantic memory recall. Without it, memory search still works through full-text search.

## Private plugins

Plugins register deployment-specific tools, recurring background jobs, and lifecycle handlers without editing the built-in registry or committing private integrations to this repository. Managed plugins install into `workspace/plugins/` and are registered in `workspace/config/plugins.json`.

```bash
umiro plugin install <git-url>
umiro plugin install <git-url> --workspace <package-name-or-path>
umiro plugin list
umiro plugin enable <name>
umiro plugin disable <name>
umiro plugin update [name]
umiro plugin remove <name>
```

A plugin package declares its entry as `"umiro": { "plugin": "./dist/index.js" }` in `package.json`. The installer runs dependency installation and an optional `build` script, but deliberately does not restart the gateway.

Discord's owner-only `/plugin` command takes a required `action` option (`install`, `update`, or `remove`) and an optional `target` string, which accepts a GitHub URL for installation and offers installed-plugin autocomplete for update and removal. Omitting `target` while updating updates every managed source. The caller is compared directly against `discord.owner_id`, because installing a plugin executes trusted code on the host — Discord installs accept public HTTPS GitHub links only, while local paths, SSH sources, and enable/disable maintenance stay on the host CLI.

> [!WARNING]
> Plugin code runs inside the Umiro process without a sandbox. Tool permissions still flow through the central registry.

See [docs/PLUGINS.md](docs/PLUGINS.md) for the first-plugin tutorial, packaging examples, monorepo installation, the API contract, and troubleshooting.

## Development

```bash
npm install
npm run build      # type-check and emit JavaScript into dist/
npm run dev        # start the local CLI
npm run typecheck  # type-check without emitting
```

## Uninstall

```bash
sudo systemctl stop umiro
sudo systemctl disable umiro
sudo rm /etc/systemd/system/umiro.service
sudo systemctl daemon-reload
npm unlink -g umiro
rm -rf ~/.umiro
```

> [!CAUTION]
> Run the final command only after backing up any workspace data you want to keep.

---

<div align="center">
<img src="assets/umiro-brand.png" alt="Umiro brand sheet" width="600">
</div>
