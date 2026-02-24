# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DNS-01 wildcard certificate auto-renewal tool. A single-file Node.js application that obtains and renews Let's Encrypt wildcard SSL certificates using DNS-01 ACME challenges, with Cloudflare and Alibaba Cloud DNS provider support. After successful issuance it reloads nginx.

## Commands

```bash
npm install     # Install dependencies
npm start       # Run the application (equivalent to: node index.js)
```

There is no build step, linter, or test suite configured.

## Architecture

All application logic lives in `index.js`. Configuration is loaded from `.env` (see `.env.example` for template).

### Execution Flow

1. Load env vars via `dotenv`, set public DNS resolvers (1.1.1.1, 8.8.8.8)
2. Run `checkRenewal()` immediately on startup
3. Schedule daily cron job at 2 AM (`node-cron`) to re-check
4. `checkRenewal()` reads existing cert — if ≤30 days remain, triggers `obtainCertificateWithRetry()`
5. ACME flow: create order → create DNS TXT record → wait for propagation → validate → finalize → save cert/key → reload nginx

### Key Functions

- `changeTxtRecord(value)` / `deleteTxtRecord(recordId)` — DNS provider abstraction (Cloudflare or Aliyun, selected by `DNS_PROVIDER` env var)
- `cleanupChallengeRecords()` — removes pre-existing `_acme-challenge` TXT records before issuance
- `waitForDns(name, value)` — polls public resolvers until the TXT record is visible
- `obtainCertificate()` — full ACME certificate issuance flow
- `obtainCertificateWithRetry(maxAttempts)` — retry wrapper with exponential backoff (30s base)
- `checkRenewal()` — reads cert expiry, triggers renewal if needed
- `reloadNginx()` — executes `nginx -s reload`

### DNS Provider Integration

Provider is selected via `DNS_PROVIDER` env var (`cloudflare` or `aliyun`). Both implement the same interface (`changeTxtRecord`/`deleteTxtRecord`). To add a new provider, add corresponding branches in these two functions.

### Output

Certificate files (`cert.pem`, `privkey.pem`) are written to the directory specified by `CERT_DIR`.

## Environment Variables

Key variables (defined in `.env`): `ACCOUNT_EMAIL`, `DNS_PROVIDER`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, `DOMAIN`, `CERT_DIR`, `RETRY_ATTEMPTS`, `PROPAGATION_ATTEMPTS`, `PROPAGATION_INTERVAL`, `DNS_SERVERS`.
