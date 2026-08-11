# Toolbox Store Worker

The product-neutral default deployment is named `toolbox-store` and uses the
`TOOLBOX_STORE` R2 binding. It backs:

- `mcpctl` catalogs, inherited profiles, and encrypted secret state; and
- `skillsctl` skill directories, inherited packs, and target overrides;
- `promptctl` persistent Claude/Codex Markdown and reusable snippets; and
- `agentctl workspace` encrypted manifests that bind those three Store types,
  shared development presets, and the portable Provider/Secret/failover/pricing
  bundle behind one master recovery code.

Each logical store has a separate random ID, write capability, encryption
root, and recovery code. The Worker is product-neutral: it stores immutable,
opaque versions in one private R2 bucket and never receives a recovery root or
snapshot decryption key.

The bundled Web UI serves from the same Worker. It is a Vite/React application
built from the actual shadcn/ui component source under `web/src/components/ui`,
with Tailwind CSS design tokens and persisted Light, Dark, and System themes. A
`toolbox1_…` code unlocks one Workspace with Providers, MCP, Skills, Prompts,
and Presets tabs;
the three isolated recovery-code formats still open a single Store directly.
Decryption and encryption use Web Crypto in the browser, and recovery material
is kept in current-tab `sessionStorage`: it survives a refresh, but clicking
Lock or closing the tab clears it. It is never written to persistent
`localStorage` or sent to the Worker. Unsaved decrypted edits trigger the
browser's leave-page confirmation before a refresh or tab close.
The UI supports search, sorting, profile/pack membership, prompt and snippet
editing, MCP provider inspection, masked MCP and Provider Secret editing,
strict Provider/failover/pricing catalog editing, version restore, and JSON
import/export. MCP exports are redacted by default and preserve the current
tab's encrypted Secret values when re-imported. Skills and Prompt exports are
still decrypted plaintext and must be handled as sensitive data.

The Presets tab composes one MCP profile, Skills pack, and Prompt profile. It
validates every reference against the attached child Stores before saving a
new encrypted Workspace version. After browser edits, run
`agentctl preset pull --yes`, review with `agentctl preset plan`, and apply it
locally; the browser never writes agent configuration files.

Keenable and Tavily appear as normal catalog entries after `mcpctl sync` and
backup. Selecting a server shows its authentication mode and Secret fields.
Tavily keyless, API-key, and OAuth entries are mutually exclusive; enabling
one turns the other two off in that profile. OAuth tokens remain in the MCP
client and never enter the Worker snapshot. After saving Web UI changes, run
`mcpctl restore --force` on a machine that should consume the new remote
version, review the restored profile, and then run `mcpctl plan` / `apply`.

Web access is disabled for each logical store by default. The matching
controller can enable, inspect, or disable it without affecting CLI backup and
restore:

```bash
mcpctl remote ui enable
mcpctl remote ui status
mcpctl remote ui disable

skillsctl remote ui enable
skillsctl remote ui status
skillsctl remote ui disable

promptctl remote ui enable
promptctl remote ui status
promptctl remote ui disable

agentctl workspace ui enable
agentctl workspace ui status
agentctl workspace ui disable
```

The public login shell contains no store metadata. Browser-marked API requests
are rejected with `web_ui_disabled` unless that individual store is enabled.

## Security model

The Worker:

- stores only a SHA-256 digest of each store's write capability;
- requires that capability for every private store operation;
- requires the deployment-wide `CREATE_TOKEN` only to create a store;
- limits snapshot bodies to 5 MiB by default;
- creates immutable backup objects and conditionally updates their head;
- exposes no delete endpoint; and
- applies a restrictive CSP and security headers to the API and UI.

Anyone with an isolated recovery code can decrypt and update that child Store.
Anyone with the master Workspace code can recover the capabilities for every
attached child Store, decrypt Provider Secret values, and edit shared catalogs,
so keep it offline with the same care as all child codes and Provider
credentials combined. The `CREATE_TOKEN`
cannot read or decrypt any Store. Remove it
after creating all required Stores, and temporarily recreate it only while
provisioning another one.

Local Worker development uses Node.js 22+ and Wrangler. Both controllers
support Node.js 20+.

## API

All private requests use:

```text
Authorization: Bearer <43-character base64url capability>
```

Store creation additionally accepts the product-neutral header:

```text
X-Toolbox-Store-Create-Token: <deployment bootstrap secret>
```

Every controller uses the product-neutral `X-Toolbox-Base-Version` and
`X-Toolbox-Store-Version` headers. Snapshot content types remain
controller-specific so encrypted envelopes can be validated before storage.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Browser management UI |
| `GET` | `/health` | Public liveness check |
| `PUT` | `/v1/stores/:storeId` | Create a client-generated logical store |
| `GET` | `/v1/stores/:storeId` | Read latest-version metadata |
| `PUT` | `/v1/stores/:storeId/versions` | Add an encrypted snapshot |
| `GET` | `/v1/stores/:storeId/versions` | List versions |
| `GET` | `/v1/stores/:storeId/latest` | Download the latest ciphertext |
| `GET` | `/v1/stores/:storeId/versions/:version` | Download one ciphertext |
| `GET` | `/v1/stores/:storeId/settings/web-ui` | Read per-store Web UI access |
| `PUT` | `/v1/stores/:storeId/settings/web-ui` | Enable or disable Web UI access |

A first upload sends a base version of `none`; later uploads send the current
version. A stale upload receives `409 version_conflict`, preventing one tab or
machine from silently replacing a newer backup.

## Local development

```bash
cd workers/toolbox-store
cp .dev.vars.example .dev.vars
npm ci
npm run dev
```

Replace the example bootstrap token first. Wrangler uses a local R2
simulation. Clients accept HTTP only for localhost; deployed endpoints must
use HTTPS. For UI-only development with Vite hot reload, use `npm run dev:ui`;
API operations still require the full `npm run dev` Worker session.

## Deploy or upgrade

For a new installation, use the product-neutral defaults:

```bash
cd workers/toolbox-store
npm ci
npm run validate
npx wrangler r2 bucket create toolbox-store
npx wrangler secret put CREATE_TOKEN
npm run deploy
cd ../..
```

This creates the `toolbox-store` Worker, the `toolbox-store` R2 bucket, and the
`TOOLBOX_STORE` binding. Initialize every logical Store against its shared
endpoint:

```bash
./agent/mcpctl/mcpctl remote init \
  --endpoint https://toolbox-store.<account-subdomain>.workers.dev

./agent/skillsctl/skillsctl remote init \
  --endpoint https://toolbox-store.<account-subdomain>.workers.dev

./agent/promptctl/promptctl remote init \
  --endpoint https://toolbox-store.<account-subdomain>.workers.dev

./agent/agentctl/agentctl workspace init \
  --endpoint https://toolbox-store.<account-subdomain>.workers.dev
```

Each command prints its own recovery code and uploads an initial snapshot.
Attach all child Stores to make the master code the normal login:

```bash
agentctl workspace attach mcp
agentctl workspace attach skills
agentctl workspace attach prompts
agentctl workspace status
```

The current Workspace manifest is strict schema 3. It includes the encrypted
`presets` object plus an optional agent bundle for portable Provider profiles,
their native compaction and model-context policies, Provider Secret values,
failover routes, and versioned pricing. The browser
normalizes legacy schema 1 and 2 manifests in memory without mutating their
immutable remote versions; the CLI exposes an explicit preview-first migration.
Generated client files and proxy/runtime state are never stored in Workspace.

The child Stores and their version histories are not migrated or duplicated.
Confirm all backups before disabling new-Store creation:

```bash
npx wrangler secret delete CREATE_TOKEN
```

Keep the R2 bucket private. Neither deployment target sends snapshot
decryption keys or recovery roots to Cloudflare.

## Verify

```bash
npm test
npm run validate
```

Tests cover the API in isolation and through Wrangler's Workerd/R2 harness.
Validation also regenerates bindings and builds a dry-run deployment bundle,
including the static Web UI.
