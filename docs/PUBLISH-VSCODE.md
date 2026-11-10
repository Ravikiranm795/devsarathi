# Publishing the DevSarathi extension to the VS Code Marketplace

Everything that can be prepared is done: the extension is packaged with the official `vsce` (icon, README, CHANGELOG,
LICENSE.txt, workspace-trust declaration) and verified in a real VS Code. What is left needs **your accounts**.

## One-time setup (about 15 minutes)

1. **Microsoft account and Azure DevOps organization.** Sign in at https://dev.azure.com with a Microsoft account (a personal one is
   fine) and create an organization if you have none.
2. **Personal access token (PAT).** In Azure DevOps: User settings > Personal access tokens > New token.
   - Organization: **All accessible organizations**
   - Scopes: **Custom defined**, show all scopes, tick **Marketplace > Manage**
   - Copy the token once. Treat it like a password; never paste it into a chat or commit it.
3. **Publisher.** Go to https://marketplace.visualstudio.com/manage > Create publisher. Choose an **ID** (lower case, unique, cannot be
   changed later) and a display name. If the ID is not `ravikiranm`, change `"publisher"` in `packages/vscode/package.json`.
   Note: the extension id becomes `<publisher>.devsarathi`.

## Before the first publish

- [ ] The CLI is on npm (`@ravikiranm795/dev-sarathi`) at the version you want users to get. The extension needs it. Publish a newer
      npm version first if you want users to have agent names and `enrich` (1.0.1 predates them): `npm version minor` then `npm publish --access public`.
- [ ] `LICENSE.txt` in `packages/vscode` is the proprietary text you chose. Check the copyright holder (it says "Ravikiran M.").
      If your employer owns work made on company time, settle that first (MASTER.md section 27: the courtesy heads-up).
- [ ] Optional but good: add screenshots to `packages/vscode/README.md` (Marketplace shows the README) and a `repository` URL
      in `packages/vscode/package.json` once the source has a public home.
- [ ] Bump `version` in `packages/vscode/package.json` for each release (the Marketplace rejects a version it already has).

## Publish

```bash
npm run build
node scripts/publish-vscode.js --dry-run     # checks everything, builds the .vsix, publishes nothing
node scripts/publish-vscode.js               # asks for a final "publish", logs in (paste the PAT at vsce's prompt), publishes
```

Add `--pre-release` to publish as a pre-release (the manifest is already marked `preview: true`, which shows a Preview badge).
Instead of the prompt you can set `VSCE_PAT` in your terminal session first.

The listing appears at `https://marketplace.visualstudio.com/items?itemName=<publisher>.devsarathi` after an automatic scan (usually
a few minutes). Install it with `code --install-extension <publisher>.devsarathi`.

## After publishing

- Updates: bump the version, rebuild, run the script again.
- Open VSX (for VSCodium, Cursor and others): `npx ovsx publish packages/vscode/devsarathi.vsix -p <open-vsx-token>` after creating a namespace there.
- A published version cannot be replaced. `npx vsce unpublish` exists but removes the listing and its install count, so prefer shipping a fixed version.
- Marketplace rules: the name and description must not imply Microsoft or Anthropic endorsement; the README must not make claims you
  cannot back. DevSarathi's README states what it sends and what it does not.
