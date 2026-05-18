# Promotion Copy

## GitHub Repository Description

Minimal macOS CLI for WeChat iLink with ephemeral QR login, local message watch, bridge mode, and media send support.

## Suggested GitHub Topics

`wechat`, `wx`, `cli`, `ilink`, `bot`, `macos`

## Short Post

Open sourced `wx-ilink-cli`, a minimal local macOS CLI for WeChat iLink.

- QR login on demand
- foreground watch mode
- JSON bridge mode for integrations
- send text and media replies
- local cache for peers, aliases, recent messages, and downloaded media

Repo:

```text
https://github.com/ccuuu/wx-ilink-cli
```

Quick start:

```sh
git clone git@github.com:ccuuu/wx-ilink-cli.git
cd wx-ilink-cli
nvm use
npm install
npm run build
node dist/src/cli.js --help
```

## Long Post

I open sourced `wx-ilink-cli`, a small local WeChat iLink transport for macOS.

What it does:

- scans a QR code when a command needs live WeChat connectivity
- watches incoming messages in foreground mode
- exposes a JSON bridge mode for integrations
- sends text, images, videos, and files
- keeps aliases, recent peers, sync cursor, and media downloads in local files

The project is intentionally local-first and experimental. It is not an
official WeChat Bot API and it does not persist login sessions for reuse.

Repository:

```text
https://github.com/ccuuu/wx-ilink-cli
```

## Demo Script

1. Build the CLI:

   ```sh
   git clone git@github.com:ccuuu/wx-ilink-cli.git
   cd wx-ilink-cli
   nvm use
   npm install
   npm run build
   ```

2. Start watch mode:

   ```sh
   node dist/src/cli.js watch --resume
   ```

3. Show recent peers:

   ```sh
   node dist/src/cli.js recent
   ```

4. Send a reply:

   ```sh
   node dist/src/cli.js send <user-id-or-alias> "hello"
   ```
