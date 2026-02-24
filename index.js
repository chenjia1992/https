/*
 * dns01-autorenew: obtain wildcard certificate for *.example.com via ACME DNS-01
 * This example uses Cloudflare's API for updating TXT records. Adjust provider logic
 * for your DNS service.
 *
 * Usage:
 *   - create a .env file based on .env.example with your account data
 *   - npm install
 *   - node index.js
 *
 * The script will request a cert, save it locally, and schedule daily renewal checks.
 * After every successful issuance/renewal it will reload nginx using "nginx -s reload".
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cron = require('node-cron');
const acme = require('acme-client');
const axios = require('axios');
const dns = require('dns').promises;

// force public resolvers to avoid local DNS issues (ECONNREFUSED)
// override via DNS_SERVERS env (comma-separated)
const publicServers = process.env.DNS_SERVERS ? process.env.DNS_SERVERS.split(',') : ['1.1.1.1', '8.8.8.8'];
require('dns').setServers(publicServers);

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}


// helper to poll public DNS until a TXT record appears
// wait until the TXT record shows up in public DNS
// `PROPAGATION_ATTEMPTS` and `PROPAGATION_INTERVAL` can be overridden via env
const PROPAGATION_ATTEMPTS = parseInt(process.env.PROPAGATION_ATTEMPTS || '180', 10);
const PROPAGATION_INTERVAL = parseInt(process.env.PROPAGATION_INTERVAL || '10000', 10);
async function waitForDns(name, value, attempts = PROPAGATION_ATTEMPTS, interval = PROPAGATION_INTERVAL) {
    for (let i = 0; i < attempts; i++) {
        try {
            const records = await dns.resolveTxt(name);
            const flat = records.flat();
            log(`dns query attempt ${i+1}/${attempts}: ${JSON.stringify(flat)}`);
            if (flat.includes(value)) {
                return;
            }
        } catch (e) {
            log(`dns lookup failed (${i+1}): ${e.message}`);
        }
        await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`DNS record ${name} did not appear within expected time`);
}

// configuration from environment
const {
    ACCOUNT_EMAIL,
    DNS_PROVIDER = 'cloudflare',     // cloudflare or aliyun
    CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ZONE_ID,
    ALIYUN_ACCESS_KEY_ID,
    ALIYUN_ACCESS_KEY_SECRET,
    DOMAIN = '*.example.com',
    CERT_DIR = './ssl'
} = process.env;

if (!ACCOUNT_EMAIL) {
    console.error('Missing ACCOUNT_EMAIL. See .env.example');
    process.exit(1);
}

if (DNS_PROVIDER === 'cloudflare' && (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID)) {
    console.error('Missing Cloudflare credentials (API token / zone id).');
    process.exit(1);
}
if (DNS_PROVIDER === 'aliyun' && (!ALIYUN_ACCESS_KEY_ID || !ALIYUN_ACCESS_KEY_SECRET)) {
    console.error('Missing Aliyun credentials (access key).');
    process.exit(1);
}

// prepare provider clients
let aliyunClient;
if (DNS_PROVIDER === 'aliyun') {
    const PopCore = require('@alicloud/pop-core');
    aliyunClient = new PopCore({
        accessKeyId: ALIYUN_ACCESS_KEY_ID,
        accessKeySecret: ALIYUN_ACCESS_KEY_SECRET,
        endpoint: 'https://alidns.aliyuncs.com',
        apiVersion: '2015-01-09'
    });
}

async function changeTxtRecord(value) {
    const baseDomain = DOMAIN.replace('*.', '');
    if (DNS_PROVIDER === 'cloudflare') {
        const recordName = `_acme-challenge.${baseDomain}`;
        log(`creating Cloudflare TXT ${recordName} -> ${value}`);
        const resp = await axios.post(
            `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records`,
            {
                type: 'TXT',
                name: recordName,
                content: value,
                ttl: 1,
                proxied: false
            },
            {
                headers: {
                    Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        log('cloudflare response: ' + JSON.stringify(resp.data));
        if (!resp.data.success) {
            throw new Error('failed to create dns record: ' + JSON.stringify(resp.data.errors));
        }
        // verify after creation with external DNS query
        const created = resp.data.result.content;
        if (created !== value) {
            throw new Error(`cloudflare wrote different content: expected=[${value}], got=[${created}]`);
        }
        log(`record created on Cloudflare with proxied=${resp.data.result.proxied}`);
        // wait extra time for Cloudflare to update nameservers
        log('waiting 15 seconds for Cloudflare to propagate to nameservers...');
        await new Promise(r => setTimeout(r, 15000));
        return resp.data.result.id;
    } else if (DNS_PROVIDER === 'aliyun') {
        const rr = '_acme-challenge';
        const params = {
            DomainName: baseDomain,
            RR: rr,
            Type: 'TXT',
            Value: value,
            TTL: 600
        };
        const result = await aliyunClient.request('AddDomainRecord', params, { method: 'POST' });
        return result.RecordId;
    } else {
        throw new Error('unsupported DNS_PROVIDER ' + DNS_PROVIDER);
    }
}

async function deleteTxtRecord(recordId) {
    if (DNS_PROVIDER === 'cloudflare') {
        await axios.delete(
            `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`,
            {
                headers: {
                    Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`
                }
            }
        );
    } else if (DNS_PROVIDER === 'aliyun') {
        await aliyunClient.request('DeleteDomainRecord', { RecordId: recordId }, { method: 'POST' });
    }
}

// remove any pre-existing `_acme-challenge` TXT records before beginning
async function cleanupChallengeRecords() {
    const baseDomain = DOMAIN.replace('*.', '');
    const name = `_acme-challenge.${baseDomain}`;
    if (DNS_PROVIDER === 'cloudflare') {
        // list records matching the name
        const resp = await axios.get(
            `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records`,
            { params: { type: 'TXT', name } ,
              headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` }
            }
        );
        if (resp.data.success && resp.data.result.length) {
            log(`found ${resp.data.result.length} existing _acme-challenge TXT records, deleting all`);
            for (const rec of resp.data.result) {
                log(`deleting existing Cloudflare TXT id=${rec.id} name=${rec.name} content=${rec.content}`);
                await axios.delete(
                    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${rec.id}`,
                    { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` } }
                );
            }
            // wait for deletion to propagate
            log('waiting 10 seconds for deletions to propagate...');
            await new Promise(r => setTimeout(r, 10000));
        } else {
            log('no existing _acme-challenge TXT records found');
        }
    } else if (DNS_PROVIDER === 'aliyun') {
        const rr = '_acme-challenge';
        // list records via DescribeDomainRecords filter
        const list = await aliyunClient.request('DescribeDomainRecords', {
            DomainName: baseDomain,
            Type: 'TXT',
            RR: rr
        }, { method: 'POST' });
        if (list.DomainRecords && list.DomainRecords.Record && list.DomainRecords.Record.length) {
            log(`found ${list.DomainRecords.Record.length} existing Aliyun TXT records, deleting all`);
            for (const rec of list.DomainRecords.Record) {
                log(`deleting existing Aliyun TXT id=${rec.RecordId} value=${rec.Value}`);
                await aliyunClient.request('DeleteDomainRecord', { RecordId: rec.RecordId }, { method: 'POST' });
            }
            log('waiting 10 seconds for deletions to propagate...');
            await new Promise(r => setTimeout(r, 10000));
        } else {
            log('no existing Aliyun TXT records found');
        }
    }
}

async function obtainCertificate() {
    const baseDomain = DOMAIN.replace('*.', '');
    // don't pre-cleanup; only delete after successful validation to avoid losing records on retry
    log('starting ACME client');
    const client = new acme.Client({
        directoryUrl: acme.directory.letsencrypt.production,
        accountKey: await acme.forge.createPrivateKey()
    });

    // create account
    await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${ACCOUNT_EMAIL}`]
    });

    const [key, csr] = await acme.forge.createCsr({
        commonName: DOMAIN,
        altNames: [DOMAIN]
    });

    const order = await client.createOrder({
        identifiers: [{ type: 'dns', value: DOMAIN }]
    });

    const authz = await client.getAuthorizations(order);
    const recordIds = []; // track records we create so we can delete them later
    for (let a of authz) {
        const challenge = a.challenges.find(c => c.type === 'dns-01');
        // getChallengeKeyAuthorization already returns base64url(SHA256(keyAuth)) for dns-01
        const dnsValue = await client.getChallengeKeyAuthorization(challenge);

        const recordId = await changeTxtRecord(dnsValue);
        recordIds.push(recordId); // track this record for later cleanup
        // wait for propagation by querying DNS directly
        const lookupName = `_acme-challenge.${baseDomain}`;
        log(`waiting for DNS TXT ${lookupName} = ${dnsValue} (length=${dnsValue.length})`);
        await waitForDns(lookupName, dnsValue);
        log('DNS record found, proceeding with challenge validation');
        
        // double-check: manually verify the exact DNS value before ACME verification
        try {
            const finalCheck = await dns.resolveTxt(lookupName);
            const finalValues = finalCheck.flat();
            log(`final DNS verification before ACME: ${JSON.stringify(finalValues)}`);
            if (!finalValues.includes(dnsValue)) {
                log(`warning: DNS value mismatch on final check, but proceeding with ACME verification`);
            }
        } catch (err) {
            log(`warning: final DNS check failed (${err.message}), but proceeding with ACME verification`);
        }
        
        log(`verifying challenge with ACME, dnsValue=${dnsValue}`);
        await client.verifyChallenge(a, challenge);
        log('challenge verified, finalizing');
        await client.completeChallenge(challenge);
        log('challenge completed, waiting for valid status');
        await client.waitForValidStatus(challenge);
        log('challenge is valid, cleaning up DNS records');
        // delete records we created in this authorization
        for (const id of recordIds) {
            await deleteTxtRecord(id);
        }
        recordIds.length = 0; // clear the list
    }

    await client.finalizeOrder(order, csr);
    log('order finalized, waiting for certificate issuance');
    const cert = await client.getCertificate(order);
    log('certificate obtained successfully');

    if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });
    log('saving certificate and key to', CERT_DIR);
    fs.writeFileSync(path.join(CERT_DIR, 'cert.pem'), cert);
    fs.writeFileSync(path.join(CERT_DIR, 'privkey.pem'), key);

    console.log('certificate saved in', CERT_DIR);
    reloadNginx();
}

function reloadNginx() {
    try {
        execSync('nginx -s reload');
        console.log('nginx reloaded');
    } catch (err) {
        console.error('failed to reload nginx', err.message);
    }
}

function daysUntil(date) {
    const now = new Date();
    const then = new Date(date);
    const diff = then - now;
    return diff / (1000 * 60 * 60 * 24);
}

function readCertificate() {
    try {
        const certPath = path.join(CERT_DIR, 'cert.pem');
        if (!fs.existsSync(certPath)) return null;
        const pem = fs.readFileSync(certPath, 'utf8');
        return acme.openssl.readCertificateInfo(pem);
    } catch (e) {
        console.warn('failed to read existing certificate', e.message);
        return null;
    }
}

// retry wrapper for certificate obtainment with exponential backoff
async function obtainCertificateWithRetry(maxAttempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            log(`attempt ${attempt}/${maxAttempts} to obtain certificate`);
            await obtainCertificate();
            return; // success
        } catch (err) {
            lastError = err;
            log(`attempt ${attempt} failed: ${err.message}`);
            if (attempt < maxAttempts) {
                // exponential backoff: 30s, 60s, 120s ...
                const waitMs = 30000 * Math.pow(2, attempt - 1);
                log(`waiting ${waitMs / 1000}s before retry...`);
                await new Promise(r => setTimeout(r, waitMs));
            }
        }
    }
    throw lastError;
}

async function checkRenewal() {
    try {
        const info = readCertificate();
        if (info && info.notAfter) {
            const days = daysUntil(info.notAfter);
            console.log(`current cert expires in ${days.toFixed(1)} days`);
            // renew if less than 30 days remaining
            if (days > 30) {
                console.log('no renewal needed yet');
                return;
            }
        }
        console.log('checking/obtaining certificate');
        await obtainCertificateWithRetry(3);
    } catch (err) {
        console.error('renewal error after all retries:', err);
    }
}

// schedule daily check at 2am
cron.schedule('0 2 * * *', () => {
    checkRenewal();
});

// run on startup
checkRenewal();
