# Artsorakel Backend

Species identification API backend. Accepts image uploads, sends them to the Naturalis AI identification API, and enriches results with taxonomic data.

## Features

- AI-powered species identification via Naturalis API
- Automatic model selection based on user location (Norwegian, Swedish, or European)
- Taxonomic enrichment with vernacular names in multiple languages
- Red list and alien species status from Norwegian databases
- Encrypted temporary image storage
- IP-based geolocation for model selection
- Rate limiting and API token authentication
- Optional HMAC request signing per token, or an origin allowlist for browser clients
- Request logs that record a keyed hash of the caller's address rather than the address

## Requirements

- Node.js
- Docker (for deployment)

## Configuration

Create the following environment files:

**config/config.env**
```env
PORT=3000
TRUST_PROXY=1
CACHE_DIR=./cache          # optional, must survive restarts
AUTH_RATE_LIMIT_WINDOW=15  # optional, minutes
AUTH_RATE_LIMIT_MAX=5      # optional, attempts per window
```

**auth/secrets.env**
```env
ADMIN_TOKEN=your-admin-token
NATURALIS_TOKEN_NORWAY=...
NATURALIS_TOKEN_SWEDEN=...
NATURALIS_TOKEN_EUROPE=...
NATURALIS_USERNAME_NORWAY=...
NATURALIS_PASSWORD_NORWAY=...
NATURALIS_USERNAME_SWEDEN=...
NATURALIS_PASSWORD_SWEDEN=...
ARTDATABANKEN_TOKEN=...
IP_HASH_KEY=...  # optional, generated into auth/iphash.key when unset
IKEY=...         # Application Insights (optional)
```

`CACHE_DIR` must point at storage that survives a restart. The taxon cache is what
keeps responses fast and complete; when it is empty, uncached species come back with
only their scientific name until it refills. Every startup writes a line to the error
log stating how many entries survived, so a directory that silently loses them is
visible after one restart.

## Installation

```bash
npm install
```

## Running

```bash
# Development
npm run dev

# Production
node server.js
```

## API Endpoints

`openapi.yaml` is the full specification, including request and response shapes.

### Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/identify` | Identify species from images (requires API token) |
| POST | `/` | Legacy identification endpoint |
| GET | `/` | Service status: deployed commit, branch, build time |
| GET | `/rss` | RSS feed |
| GET | `/taxon/image/{name}` | Get profile image URL for taxon |
| GET | `/taxon/images` | Get all taxon profile images |
| GET | `/taxon/images/view` | HTML view of taxon profile images |
| GET | `/taxon/description/{sciNameId}` | Cached name record for a scientific name id |
| GET | `/taxon/description/random/id` | Cached name record for a random taxon |
| GET | `/taxon/description/view` | HTML view of cached taxon descriptions |
| POST | `/save` | Save images, returns ID and password |
| GET | `/image/{id}&{password}` | Retrieve saved images |

### Admin (requires admin token)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/tokens` | List API tokens |
| POST | `/admin/tokens` | Create new API token, returns its signing secret once |
| GET | `/admin/tokens/reload` | Reload tokens from file |
| PATCH | `/admin/tokens/{prefix}/enable` | Enable token |
| PATCH | `/admin/tokens/{prefix}/disable` | Disable token |
| POST | `/admin/tokens/{prefix}/secret` | Create or rotate the signing secret |
| DELETE | `/admin/tokens/{prefix}/secret/previous` | Retire the secret replaced by the last rotation |
| POST | `/admin/tokens/{prefix}/origins` | Restrict the token to an origin |
| DELETE | `/admin/tokens/{prefix}/origins` | Remove an origin restriction |
| GET | `/admin/ipwatch` | List watched IP buckets |
| POST | `/admin/ipwatch/{bucket}` | Log full addresses for a bucket |
| DELETE | `/admin/ipwatch/{bucket}` | Stop logging them |
| POST | `/admin/taxon/reload/name/{name}` | Reload cached taxon by name |
| POST | `/admin/taxon/reload/id/{id}` | Reload cached taxon by ID |
| POST | `/admin/taxon/reload/images` | Reload taxon profile images |
| DELETE | `/admin/taxon/cache` | Clear taxon cache |
| GET | `/admin/logs` | List log files |
| GET | `/admin/logs/{filename}` | Download log file |
| POST | `/admin/rss` | Upload RSS feed |

## Securing a token

A token is a bearer string, so anyone who obtains it can use it. Two optional controls
narrow that, and they suit different kinds of client.

**Request signing** suits a consumer that runs on its own server and can keep a secret.
Tokens created through `POST /admin/tokens` get one automatically; an existing token
gets one from `POST /admin/tokens/{prefix}/secret`. Once a token has a secret, every
request must carry `X-Artsorakel-Timestamp` and `X-Artsorakel-Signature`, and the token
alone is useless. Rotation keeps the old secret valid until
`DELETE /admin/tokens/{prefix}/secret/previous` retires it, so consumers can switch over
at their own pace.

The signature is `HMAC-SHA256(secret, canonical)`, hex encoded, sent as `v1=<hex>`. The
canonical string is these six lines joined by newlines:

```
v1
POST
/identify
<the token>
<unix seconds>
<sha256 of: each image's sha256 hex joined by newlines, a newline, then key=value body fields sorted by key and joined by newlines>
```

Timestamps more than 300 seconds from the server clock are rejected.

**An origin allowlist** suits a browser client, which cannot keep a secret. Adding an
origin retires the token's secret, since requiring a signature from a public client only
creates the illusion of proof. While a token has origins, requests are accepted only
from those and the response echoes the matching origin instead of a wildcard, so another
site cannot use a copied token from a browser. Removing the last origin makes the token
unrestricted again.

Neither control applies to a token that has neither, which is the default.

## Logs

Request logs are one CSV per calling application per day, in `log/`. Requests
authenticated with a token are filed under the token's registered application name;
unauthenticated callers name themselves, so those files are prefixed `unauth-` and that
name is not evidence of anything.

The `IP_bucket` column holds four hexadecimal characters of a keyed hash of the caller's
address, not the address. Collisions are deliberate: a bucket is enough to spot one
caller generating unusual volume, without the log identifying anyone. To investigate a
bucket, `POST /admin/ipwatch/{bucket}` writes the full addresses behind it to
`ipwatch-<bucket>_<date>.csv` until you stop.

Failures are written to `errorlog_<date>.txt` in the same directory. That file is the
only place several conditions surface, including a GeoIP database that failed to load,
a cache that cannot be written, a lookup that has stayed unresolved across several
attempts, and whether the cache survived the last restart.

## Project Structure

```
├── config/          # Configuration files
├── middleware/      # Express middleware (auth, signing, rate limiting)
├── routes/          # API route handlers
├── services/        # Business logic
├── jobs/            # Cron jobs
├── cache/           # Cached data (taxa, images, geoip) - must be persistent
├── uploads/         # Temporary encrypted image storage
├── log/             # Request logs and the error log
└── auth/            # API tokens, secrets, IP hash key
```

## License

MIT
