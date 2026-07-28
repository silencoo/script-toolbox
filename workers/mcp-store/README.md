# mcp-store Worker

`mcp-store` is the intentionally small remote half of `mcpctl` backup and
restore. It stores versioned encrypted blobs in R2. Encryption, key derivation,
and recovery-code generation happen on the client.

Local Worker development and deployment use Wrangler 4.114 and Node.js 22 or
newer. The `mcpctl` encryption client itself supports Node.js 20 or newer.

The Worker:

- stores only a SHA-256 digest of the write capability;
- requires that capability for every store operation;
- requires a deployment-wide bootstrap secret to create a store;
- limits snapshot bodies to 5 MiB by default;
- creates immutable backup objects;
- conditionally updates the latest-version pointer using its R2 ETag;
- exposes no delete endpoint; and
- never receives the recovery root key or a snapshot decryption key.

The remote service is therefore not a replacement for encryption. Anyone who
obtains a recovery code can read and update the store, and anyone who obtains
both a local remote configuration and encrypted cache can decrypt its secrets.

## API

All private requests use:

```text
Authorization: Bearer <43-character base64url capability>
```

Store creation additionally uses:

```text
X-MCP-Store-Create-Token: <deployment bootstrap secret>
```

If the `CREATE_TOKEN` Worker secret is absent or shorter than 32 characters,
store creation returns `503` and all existing stores continue to work.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Public liveness check |
| `PUT` | `/v1/stores/:storeId` | Create a client-generated store |
| `GET` | `/v1/stores/:storeId` | Read latest-version metadata |
| `PUT` | `/v1/stores/:storeId/versions` | Add an encrypted snapshot |
| `GET` | `/v1/stores/:storeId/versions` | List versions |
| `GET` | `/v1/stores/:storeId/latest` | Download the latest ciphertext |
| `GET` | `/v1/stores/:storeId/versions/:version` | Download one ciphertext |

An upload uses
`Content-Type: application/vnd.mcpctl.snapshot+json` and
`X-MCPCTL-Base-Version: none` for the first version, or the current version
identifier for later versions. A stale upload receives `409 version_conflict`.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, replace its bootstrap token, then run:

```bash
npm install
npm run dev
```

Wrangler uses a local R2 simulation by default. The client accepts an HTTP
endpoint only for `localhost`, `127.0.0.1`, or `::1`; every non-local endpoint
must use HTTPS.

## Deploy

Deployment creates external Cloudflare resources, so it is kept as an explicit
operator step:

```bash
cd workers/mcp-store
npm install
npx wrangler r2 bucket create mcp-store
npm run validate
npx wrangler deploy
npx wrangler secret put CREATE_TOKEN
```

Choose a random value of at least 32 characters when Wrangler prompts for
`CREATE_TOKEN`. Use the same value once when `mcpctl remote init` prompts for
the store-creation token.

From the repository root:

```bash
./agent/mcpctl/mcpctl remote init \
  --endpoint https://mcp-store.<account-subdomain>.workers.dev
```

The command prints the recovery code and uploads the first encrypted snapshot.
Confirm that this succeeds before disabling creation.

After the personal store has been created and its first encrypted backup
succeeds, creation can be disabled:

```bash
npx wrangler secret delete CREATE_TOKEN
```

This does not affect backup, version listing, or restore for the existing
store. Temporarily create a new bootstrap secret only when another store must
be initialized.

Change both `bucket_name` and the Worker name in `wrangler.jsonc` if those
names are already used in the account. Keep the R2 bucket private; the Worker
binding is the only required access path.

Cloudflare rate limiting or Access can be added in front of the Worker as a
defense-in-depth measure, but Access must not be configured in a way that
requires a per-machine interactive login if recovery by one code is the goal.

## Verify

```bash
npm test
npm run validate
```

The test suite includes isolated API tests and a Wrangler test-harness pass
against the production Workerd runtime with a local R2 binding. `validate`
also regenerates binding types and builds the deployment bundle with
`wrangler deploy --dry-run`.
