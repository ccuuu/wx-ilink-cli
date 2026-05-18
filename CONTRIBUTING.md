# Contributing

Thanks for contributing to `wx-ilink-cli`.

## Development

```sh
nvm use
npm install
npm run check
```

Useful local commands:

```sh
npm run build
npm run link:wx
wx --help
```

## Pull Requests

- Keep changes focused and reviewable.
- Update `README.md` when user-facing behavior changes.
- Do not commit QR login artifacts, local cache files, media downloads, or
  machine-specific paths.
- Run `npm run check` before opening a pull request.

## Security-Sensitive Areas

Changes in QR login flow, message transport, local file/media sending, and
runtime state persistence are security-sensitive. Document the expected
behavior and test coverage in the pull request.
