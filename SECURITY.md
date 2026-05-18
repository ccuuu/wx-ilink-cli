# Security Policy

## Supported Versions

This project is experimental. Security fixes are applied to the latest release.

## Reporting a Vulnerability

Report security issues privately through GitHub Security Advisories if
available. If advisories are unavailable, open an issue with minimal public
detail and ask for a private contact path.

Do not include QR login tokens, context tokens, local message caches, media
files, or screenshots with private chat content in public issues.

## Local Secret Handling

- Login sessions are intentionally ephemeral and are not persisted for reuse.
- Runtime state such as aliases, peer reply context tokens, and sync cursors is
  stored under `~/.wx-ilink-cli/`.
- Downloaded media is stored under `~/.wx-ilink-cli/media/`.
- Legacy Keychain entries from older versions are ignored and removed during
  state cleanup.
