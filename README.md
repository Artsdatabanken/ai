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

## Requirements

- Node.js
- Docker (for deployment)

## Configuration

Create the following environment files:

**config/config.env**
```env
PORT=3000
TRUST_PROXY=1
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
IKEY=...  # Application Insights (optional)
```

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

### Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/identify` | Identify species from images (requires API token) |
| POST | `/` | Legacy identification endpoint |
| GET | `/rss` | RSS feed |
| GET | `/taxon/image/{name}` | Get profile image URL for taxon |
| GET | `/taxon/images` | Get all taxon profile images |
| GET | `/taxon/images/view` | HTML view of taxon profile images |
| POST | `/save` | Save images, returns ID and password |
| GET | `/image/{id}&{password}` | Retrieve saved images |

### Admin (requires admin token)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/tokens` | List API tokens |
| POST | `/admin/tokens` | Create new API token |
| GET | `/admin/tokens/reload` | Reload tokens from file |
| PATCH | `/admin/tokens/{prefix}/enable` | Enable token |
| PATCH | `/admin/tokens/{prefix}/disable` | Disable token |
| POST | `/admin/taxon/reload/name/{name}` | Reload cached taxon by name |
| POST | `/admin/taxon/reload/id/{id}` | Reload cached taxon by ID |
| POST | `/admin/taxon/reload/images` | Reload taxon profile images |
| DELETE | `/admin/taxon/cache` | Clear taxon cache |
| GET | `/admin/logs` | List log files |
| GET | `/admin/logs/{filename}` | Download log file |
| POST | `/admin/rss` | Upload RSS feed |

## Project Structure

```
├── config/          # Configuration files
├── middleware/      # Express middleware (auth, rate limiting)
├── routes/          # API route handlers
├── services/        # Business logic
├── jobs/            # Cron jobs
├── cache/           # Cached data (taxa, images, geoip)
├── uploads/         # Temporary encrypted image storage
├── log/             # Request logs
└── auth/            # API tokens
```

## License

MIT
