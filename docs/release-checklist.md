# Release Checklist

## GitHub

1. Create a public repository named `wx-ilink-cli`.
2. Push the local `main` branch.
3. Verify the GitHub Actions `CI` workflow passes.
4. Add a short repository description and topics:
   `wechat`, `wx`, `cli`, `ilink`, `bot`, `macos`
   Recommended description:
   `Minimal macOS CLI for WeChat iLink with ephemeral QR login, local message watch, bridge mode, and media send support.`

## npm

1. Confirm the package name is still available:
   `npm view wx-ilink-cli version`
2. Log in:
   `npm login`
3. Dry-run package contents:
   `npm pack --dry-run`
4. Publish:
   `npm publish`

## Smoke Verification

1. `npm install`
2. `npm run build`
3. `node dist/src/cli.js --help`
4. `node dist/src/cli.js status`
