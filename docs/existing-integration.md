# Existing FMCSA integration

Baseline reviewed: `ff13efaf0025705bd228b04b71ec754c212a16c3`, September 9, 2026.

The existing Express service is the production integration to preserve. The invoice
page in `mira598/dieselservice-app-` calls `GET /carrier/:usdot`. The service reads
`FMCSA_KEY` from Render's environment and calls the QCMobile carrier endpoint at
`https://mobile.fmcsa.dot.gov/qc/services/carriers/{usdot}?webKey=...` with an Accept
header for JSON. The key does not belong in the browser, repository, or fixtures.

## Contract before changes

| Request or upstream result | HTTP response |
| --- | --- |
| `GET /` | 200: `ok`, `service`, `keyConfigured` |
| DOT outside 2–8 digits | 400: `error` |
| Missing environment key | 500: `error` |
| Upstream non-2xx | 502: `error` containing upstream status |
| Missing carrier/legal name | 404: `error` |
| Valid carrier | 200: the fields below |
| Network/JSON exception | 500: `error`, originally including exception text |
| OPTIONS, any path | 204; no upstream request |

Both `content.carrier` and direct `content` carrier objects are accepted. The
response contains `usdot`, `legalName`, `dba`, `addr`, `city`, `state`, `zip`,
`phone`, `mcNumber`, `safetyRating`, `powerUnits`, and `drivers`. Missing values
default to empty strings. The legacy mapping also converts zero unit/driver
counts to empty strings and falls back from `mcNumber` to `mcs150Number`; these
behaviors are characterized, not silently changed. Their semantic correctness
needs provider evidence before a separate mapping fix.

Allowed browser origins default to dieselservice.io, www.dieselservice.io, and
dieselservice-app.onrender.com. `ALLOWED_ORIGINS` replaces that list. Responses
vary by Origin; GET/OPTIONS and Content-Type are advertised. A disallowed Origin
receives no allow-origin header, but the original service still processes its
request. CORS is not authentication or a quota control.

## Findings that justify focused fixes

1. There is no explicit upstream deadline. A stalled provider request can occupy
   a request until a lower-level timeout, including while consuming JSON.
2. The catch block exposes arbitrary exception text. Parser or transport errors
   can contain upstream content or a URL including the web key.
3. The dependency had no committed lockfile. The recovered working tree pinned
   Express to 4.22.1; validate the resolved dependency tree and commit its lock.

Characterization tests execute the real, initially unchanged `server.js` with
Express over loopback HTTP. Only the provider fetch and environment are replaced
with synthetic fixtures. No production key, customer record, or paid lookup is
used. This documents compatibility; it is not a live FMCSA or load test.

## Scope still requiring production work

The public endpoint has no authenticated per-shop quota, distributed rate limit,
cache, or circuit breaker. Do not claim CORS protects the API key's quota. These
require an agreed deployment/authentication boundary and measured limits; they
are not bundled into the timeout/error fix. No rating engine is derived from
FMCSA registration or safety data.
