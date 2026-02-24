# DNS-01 Wildcard Certificate Auto-Renewal

This Node.js script issues a wildcard certificate (`*.example.com`) via Let's Encrypt by performing a DNS-01 challenge using the Cloudflare API. It also schedules automatic renewals and reloads **nginx** when a new certificate is obtained.

> **Note:** Two providers are built in: Cloudflare (default) and Alibaba Cloud DNS. The `DNS_PROVIDER` environment variable selects which one is used. You can still adapt the `changeTxtRecord`/`deleteTxtRecord` functions for other services if needed.

## Setup

1. **Install dependencies**
   ```bash
   cd c:\Users\inno\Desktop\https
   npm install
   ```

2. **Configure environment**
   - Copy `.env.example` to `.env` and fill in values.
   - Set `DNS_PROVIDER` to either `cloudflare` or `aliyun` depending on your DNS service.
   - For Cloudflare you need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID`.
   - For Alibaba Cloud DNS you need `ALIYUN_ACCESS_KEY_ID` and `ALIYUN_ACCESS_KEY_SECRET`.
   - You may change `DOMAIN` or `CERT_DIR` if needed.

3. **Run the script**
   ```bash
   node index.js
   ```
   The script will immediately attempt to obtain a certificate and will schedule a renewal check every night at 2 AM.

4. **Nginx setup**
   - Point your server block to the files under `CERT_DIR` (`cert.pem` and `privkey.pem`).
   - Ensure the user running the Node script has permission to write to that directory.

### Renewal policy
Let's Encrypt issues certificates valid for **90 days**. This script performs a daily check at 2 AM and will only attempt to renew when the existing certificate has **30 days or fewer remaining**. That gives a safe window for propagation and avoids unnecessary ACME requests. You can adjust the threshold in `checkRenewal()` if you prefer a different window (e.g. 60 days).

### DNS propagation
The script now waits for the `_acme-challenge` TXT record to become visible on public DNS before proceeding. By default it polls every 5 seconds for up to 30 attempts (≈2½ minutes). If your DNS provider is slow to propagate you can override via environment variables:

```dotenv
PROPAGATION_ATTEMPTS=60      # number of queries
PROPAGATION_INTERVAL=10000   # milliseconds between queries
``` 

During propagation the program prints each lookup result so you can see whether the record is present or if some other TXT values are returned.

If the record never appears:

1. Double‑check that you have the correct **zone ID** and API token/credentials.
2. Ensure the domain is actually using the DNS provider (Cloudflare nameservers for the zone).
3. Manually query from an external resolver (`dig`, `nslookup`) to verify propagation.
4. Look in the provider's dashboard for the created TXT record; sometimes it may be listed under a different subdomain if the zone is wrong.

The script will now **automatically delete any pre‑existing `_acme-challenge` TXT records** for your domain when it starts a new issuance. This prevents leftover records from previous runs interfering with the challenge. You can still inspect or clear them manually via your DNS control panel if needed.

This logging makes it easier to diagnose why the ACME verifier reports “No TXT records found.”

> **Windows note:** the built-in resolver sometimes fails with `ECONNREFUSED` when talking to a local DNS service. The script now sets Cloudflare's `1.1.1.1` and Google's `8.8.8.8` by default, but you can specify your own via `DNS_SERVERS` (comma‑separated list).

5. **Custom DNS providers**
   Built‑in examples cover Cloudflare and Alibaba Cloud DNS. If you use another service, modify `changeTxtRecord`/`deleteTxtRecord` by adding your own API calls (they just need to create and later delete a TXT record and return an identifier for cleanup).

6. **Cron schedule**
   The renewal schedule is implemented with [`node-cron`](https://www.npmjs.com/package/node-cron). Adjust the cron expression in `index.js` if you want a different frequency.

## How it works
1. Creates an ACME account and order for the wildcard domain.
2. For each authorization, creates a TXT record `_acme-challenge.example.com` with the proper value.
3. Verifies and completes the challenge, deletes the record after propagation.
4. Finalizes the order and saves the certificate files.
5. Reloads nginx to apply the new cert.
6. Repeats the process daily to keep certificates up to date.

---

Customize and extend as needed for your environment or DNS provider.