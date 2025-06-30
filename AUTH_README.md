# Authentication Documentation

## Overview

This API implements a simplified token-based authentication system. The existing root endpoint (`POST /`) remains tokenless for backward compatibility, while a new secured endpoint (`POST /identify`) requires authentication.

## Authentication System

### Token Types

1. **Admin Token** - Stored in environment variable, provides full access to all endpoints
2. **API Tokens** - Stored in `config/tokens.json`, provides access to the identification endpoint only

### Endpoints

#### Legacy Endpoint (No Authentication)
- `POST /` - Species identification (legacy, no token required)

#### Secured Endpoints
- `POST /identify` - Species identification (requires API token or admin token)
- All other endpoints require admin token

## API Usage

### Admin Operations (Admin Token Required)
```bash
# List all tokens
curl -X GET https://your-api-domain.com/admin/tokens \
  -H "Authorization: Bearer your-admin-token"

# Create a new token
curl -X POST https://your-api-domain.com/admin/tokens \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "New Client Name",
    "application": "my-app",
    "description": "Token for my application"
  }'

# Enable a token (using token prefix)
curl -X PATCH https://your-api-domain.com/admin/tokens/b56be7f2/enable \
  -H "Authorization: Bearer your-admin-token"

# Disable a token (using token prefix)
curl -X PATCH https://your-api-domain.com/admin/tokens/b56be7f2/disable \
  -H "Authorization: Bearer your-admin-token"

# Reload tokens from file
curl -X POST https://your-api-domain.com/admin/tokens/reload \
  -H "Authorization: Bearer your-admin-token"
```

## Configuration

### Environment Variables

Required in `config/config.env`:

```bash
# Server Configuration
PORT=5000

# Rate Limiting for Authentication
AUTH_RATE_LIMIT_WINDOW=15
AUTH_RATE_LIMIT_MAX=5
```

Required in `config/secrets.env`:

```bash
# Authentication Configuration
ADMIN_TOKEN=your-super-secure-admin-token-change-this-immediately
```


### Tokens File

API tokens are managed in `config/tokens.json`. Each token must be associated with an application:

```json
{
  "your-api-token-1": {
    "name": "Client Name 1",
    "application": "artsorakelet",
    "enabled": true,
    "created": "2024-01-01T00:00:00Z",
    "description": "Description of what this token is for"
  },
  "your-api-token-2": {
    "name": "Client Name 2",
    "application": "research-tool",
    "enabled": false,
    "created": "2024-01-01T00:00:00Z",
    "description": "Another client token (disabled)"
  }
}
```

**Required Fields:**
- `name`: Human-readable name for the token
- `application`: Application identifier used for logging and identification
- `enabled`: Boolean indicating if the token is active (defaults to true)
- `created`: Timestamp when the token was created
- `description`: Optional description of the token's purpose

## Token Management

### Creating New API Tokens (Recommended)

Use the admin API to create tokens securely:

```bash
curl -X POST https://your-api-domain.com/admin/tokens \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Mobile App Client",
    "application": "artsorakelet-mobile",
    "description": "Token for the mobile application"
  }'
```

**Response:**
```json
{
  "message": "Token created successfully",
  "token": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
  "name": "Mobile App Client",
  "application": "artsorakelet-mobile",
  "enabled": true,
  "created": "2024-01-15T10:30:00Z",
  "warning": "Store this token securely. It will not be shown again in full."
}
```

### Managing Token Status

**Enable a token:**
```bash
curl -X PATCH https://your-api-domain.com/admin/tokens/a1b2c3d4/enable \
  -H "Authorization: Bearer your-admin-token"
```

**Disable a token:**
```bash
curl -X PATCH https://your-api-domain.com/admin/tokens/a1b2c3d4/disable \
  -H "Authorization: Bearer your-admin-token"
```

### Manual Token Management (Alternative)

1. Edit `config/tokens.json` directly
2. Add/modify entries with required fields: `name`, `application`, `enabled`, `created`
3. Reload tokens:
   ```bash
   curl -X POST https://your-api-domain.com/admin/tokens/reload \
     -H "Authorization: Bearer your-admin-token"
   ```

### Token Format

- Tokens should be long, random strings (recommended: 32+ characters)
- Use cryptographically secure random generation
- Example: `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0`

## Security Features

### Rate Limiting
- **Authentication endpoints**: 5 attempts per 15 minutes per IP
- **Main API endpoints**: 30 requests per minute per IP
- **ID endpoints**: 9999 requests per 5 minutes per IP
- **Cache endpoints**: 30 requests per minute per IP

### Access Control
- **Admin token**: Full access to all endpoints including token management
- **API tokens (enabled)**: Access to `/identify` endpoint only
- **API tokens (disabled)**: No access - treated as invalid
- **No token**: Access to legacy `/` endpoint only

### Logging
- All authentication events are logged
- Failed attempts tracked with IP addresses
- Token usage is logged (without exposing the full token)
- **Application name from token** is used for log files (more secure than user input)
- Log files are named: `{application}_{auth_type}_{date}.csv`

## Security Best Practices

1. **Change the default admin token** immediately
2. **Use strong, randomly generated tokens** (minimum 32 characters)
3. **Store the admin token securely** using environment variables
4. **Rotate tokens regularly** (recommended: every 90 days)
5. **Monitor authentication logs** for suspicious activity
6. **Use HTTPS only** in production environments
7. **Keep the tokens file secure** - do not commit it to version control

## Error Responses

### 401 Unauthorized
```json
{
  "error": "Access denied. No token provided.",
  "message": "Please include a valid Bearer token in the Authorization header."
}
```

### 403 Forbidden
```json
{
  "error": "Invalid token.",
  "message": "The provided token is invalid."
}
```

### 429 Too Many Requests
```json
{
  "error": "Too many authentication attempts. Please try again later.",
  "retryAfter": 900
}
```

## Migration Guide

### For Existing Applications
- **No changes required** - existing applications can continue using `POST /`
- **For better security** - migrate to `POST /identify` with API tokens

### For New Applications
- Use `POST /identify` with API tokens for species identification
- Request API tokens from the system administrator

## Example Token Generation

Here's a simple way to generate secure tokens:

### Using Node.js
```javascript
const crypto = require('crypto');
const token = crypto.randomBytes(32).toString('hex');
console.log(token);
```

### Using OpenSSL
```bash
openssl rand -hex 32
```

### Using Python
```python
import secrets
token = secrets.token_hex(32)
print(token)
```

## Monitoring

Authentication events are logged in the error log files with prefixes indicating:
- Successful authentications
- Failed authentication attempts  
- Token reloads
- Invalid token usage

Regular monitoring of these logs is recommended for security purposes. 