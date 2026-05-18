# wx-ilink-cli

[![CI](https://github.com/ccuuu/wx-ilink-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/ccuuu/wx-ilink-cli/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/ccuuu/wx-ilink-cli)](./LICENSE)

Minimal macOS CLI for WeChat iLink.

`wx-ilink-cli` provides a local `wx` command that can log in to WeChat with a QR
code, watch incoming messages, and send text or media replies. It is designed
as a small local transport layer, including for tools such as `codex-wechat`.

Login sessions are intentionally ephemeral. The CLI does not save WeChat login
credentials to macOS Keychain. Commands that connect to WeChat scan a QR code
when they start and keep that session only in the current process.

This is not an official WeChat Bot API. Treat it as a local personal WeChat
experiment, not an enterprise production integration.

Promotion copy and suggested repository metadata live in
[docs/promo-copy.md](./docs/promo-copy.md).

## Requirements

- macOS
- Node.js 20 or newer
- A terminal that can display the QR login URL / QR code

Check Node:

```bash
node --version
```

If this checkout has `.nvmrc`, use:

```bash
nvm use
```

## Quick Start

Clone the repository, build it, and link the local `wx` command:

```bash
git clone git@github.com:ccuuu/wx-ilink-cli.git
cd wx-ilink-cli
nvm use
npm install
npm run build
npm run link:wx
wx --help
```

Then verify the CLI:

```bash
wx status
```

If `wx` is already used by another command on the machine, use the long binary
name instead:

```bash
wx-ilink-cli --help
```

## Provided Commands

```bash
wx login [--fresh]
wx status
wx logout
wx watch [--resume] [--json] [--cache-only]
wx bridge [--resume] [--json]
wx daemon start|stop|status
wx peers
wx recent
wx chat <user-id|alias>
wx tail [--limit <n>] <user-id|alias>
wx alias
wx alias set <alias> <user-id>
wx alias rm <alias>
wx send [--context-token <token>] <user-id|alias> <text>
wx send-file [--context-token <token>] <user-id|alias> <file-path> [caption]
```

The npm package exposes two binaries:

- `wx`
- `wx-ilink-cli`

Both point to the same CLI.

## Typical Workflow

1. Start watching messages. This scans a QR code and keeps the login session in
   this process only:

   ```bash
   wx watch --resume
   ```

2. Ask the target contact to send one message to this WeChat account.

3. List recent peers:

   ```bash
   wx recent
   wx peers
   ```

4. Optionally create an alias:

   ```bash
   wx alias set zhangsan <user-id>
   ```

5. Send a text reply. This command also scans a QR code because login sessions
   are not persisted:

   ```bash
   wx send zhangsan "hello"
   ```

6. Send a local file or image:

   ```bash
   wx send-file zhangsan ./report.png "latest report"
   ```

`wx send` and `wx send-file` need a `context_token`. The easiest way to get one
is to run `wx watch`, `wx bridge`, or `wx daemon start` and receive at least one
message from that peer.

Images, files, videos, and voice messages are downloaded when possible and
stored under:

```bash
~/.wx-ilink-cli/media/
```

In JSON mode, downloaded media appears on the message as `attachments`:

```json
{
  "attachments": [
    {
      "kind": "image",
      "path": "/Users/me/.wx-ilink-cli/media/2026-05-16/image-123-0.jpg",
      "fileName": "image-123-0.jpg",
      "size": 12345
    }
  ]
}
```

## Long-Running Watcher

Foreground mode:

```bash
wx watch --resume
```

JSON mode for integrations:

```bash
wx watch --resume --json
```

Bidirectional bridge mode for integrations:

```bash
wx bridge --resume --json
```

In bridge mode:

- stdout emits incoming WeChat messages as JSON lines.
- stderr prints QR login and diagnostic output.
- stdin accepts JSON-line commands for outgoing text and media messages.

Example stdin command:

```json
{"cmd":"send","to":"<user-id-or-alias>","text":"hello"}
```

Example media command:

```json
{"cmd":"sendMedia","to":"<user-id-or-alias>","path":"/tmp/report.png","caption":"latest report"}
```

Background daemon mode:

```bash
wx daemon start
wx daemon status
wx daemon stop
```

Daemon mode scans a QR code when it starts. It updates local peer and
recent-message caches, which makes `wx send`, `wx recent`, and `wx tail` more
convenient.

## Local Chat Helper

After a peer is cached, start a simple terminal chat. This scans a QR code for
the chat process:

```bash
wx chat zhangsan
```

Inside chat:

```text
/tail
/tail 20
/exit
```

## Recent Messages

List recent chats:

```bash
wx recent
```

Tail cached messages for a peer:

```bash
wx tail zhangsan
wx tail --limit 20 zhangsan
```

History is local-cache based. This CLI does not provide full server-side
historical message sync.

## Use With codex-wechat

`codex-wechat` from `codex-discord-multisession` depends on this `wx` command.
The relationship is:

```text
codex-wechat
  -> wx
     -> wx-ilink-cli
```

Install and verify `wx` first:

```bash
git clone git@github.com:ccuuu/wx-ilink-cli.git
cd wx-ilink-cli
nvm use
npm install
npm run link:wx
wx status
```

Then start the Codex bridge:

```bash
git clone git@github.com:ccuuu/codex-discord-multisession.git
cd codex-discord-multisession
npm install
npm run build
codex-wechat doctor
codex-wechat start
```

`codex-wechat start` uses `wx bridge --resume --json`, so it scans a QR code for
each bridge process and does not need a saved WeChat login session.

## Privacy Notes

- WeChat login credentials are not saved to macOS Keychain.
- Non-login runtime metadata is stored locally under:
  - `~/.wx-ilink-cli/runtime.json`
  This includes aliases, sync cursor, and peer reply context tokens.
- Recent message cache is stored locally under:
  - `~/.wx-ilink-cli/cache.json`
- Downloaded media is stored locally under:
  - `~/.wx-ilink-cli/media/`
- Daemon PID and log are stored under:
  - `~/.wx-ilink-cli/`
- Only a bounded recent cache is kept, not a full transcript archive.

Do not commit exported logs, local cache files, or screenshots containing QR
login URLs.

## Development

Install dependencies:

```bash
nvm use
npm install
```

Build:

```bash
npm run build
```

Typecheck:

```bash
npm run typecheck
```

Link the local `wx` command:

```bash
npm run link:wx
```

Package dry run:

```bash
npm pack --dry-run
```

## Troubleshooting

### `wx` command not found

Run:

```bash
git clone git@github.com:ccuuu/wx-ilink-cli.git
cd wx-ilink-cli
npm run link:wx
which wx
```

If `wx` conflicts with another command, use:

```bash
wx-ilink-cli --help
```

### It asks me to scan every time

This is expected. WeChat login credentials are not persisted. Start the command
that needs WeChat connectivity and scan the QR code for that process:

```bash
wx watch --resume
wx bridge --resume --json
```

`wx login` is only a one-shot QR login check now. It does not prepare a saved
session for later commands.

If you want to clear old runtime metadata from earlier versions:

```bash
wx logout
```

### `wx send` cannot reply to a user

Make sure that peer has sent at least one message while `wx watch`, `wx bridge`,
or `wx daemon start` was running:

```bash
wx watch --resume
wx bridge --resume --json
```

Then check:

```bash
wx peers
wx recent
```

### Node version warning

Use Node.js 20 or newer:

```bash
nvm use
node --version
```
