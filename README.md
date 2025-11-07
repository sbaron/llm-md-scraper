# LLM Markdown Scraper Service

A web scraping service built with Playwright and Fastify that converts web pages to clean markdown format using Mozilla's Readability library. This tool is designed to produce content from web pages optimized for use by Large Language Models (LLMs) and AI applications.


## Features

- 🚀 **Fast & Efficient**: Uses Playwright with persistent browser instances and isolated contexts
- 🛡️ **Security**: SSRF protection, rate limiting, and security headers
- 📊 **Production Ready**: Health checks, graceful shutdown, retry logic, and comprehensive error handling
- 🎯 **Clean Output**: Converts HTML to markdown using Readability and Turndown
- ⚡ **Performance**: Resource blocking for faster scraping
- 🔧 **Configurable**: Environment-based configuration
- 📝 **Logging**: Structured logging with request tracking

## Quick Start

This service is designed to run in containers using Podman or Docker.

### Build the Container

```bash
podman build -t llm-md-scraper .
```

### Run the Container

Basic usage:

```bash
podman run -d \
  --name llm-md-scraper \
  -p 3000:3000 \
  llm-md-scraper
```

With custom configuration:

```bash
podman run -d \
  --name llm-md-scraper \
  -p 3000:3000 \
  -e RATE_LIMIT_MAX=20 \
  -e PAGE_TIMEOUT=60000 \
  llm-md-scraper
```

Or using an environment file:

```bash
# Create your environment file
cp .env.example .env
# Edit .env with your settings
nano .env

# Run with env file
podman run -d \
  --name llm-md-scraper \
  -p 3000:3000 \
  --env-file .env \
  llm-md-scraper
```

### Configuration Options

Available environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `HOST` | 0.0.0.0 | Server host |
| `BROWSER_HEADLESS` | true | Run browser in headless mode |
| `PAGE_TIMEOUT` | 30000 | Page load timeout (ms) |
| `REQUEST_TIMEOUT` | 45000 | Overall request timeout (ms) |
| `RATE_LIMIT_MAX` | 10 | Max requests per time window |
| `RATE_LIMIT_WINDOW` | 1 minute | Rate limit time window |
| `BROWSER_LAUNCH_MAX_RETRIES` | 3 | Browser launch retry attempts |
| `BLOCK_RESOURCES` | true | Block images/fonts/media |
| `CORS_ORIGIN` | false | CORS origin (optional) |

### Verify Installation

```bash
# Check if container is running
podman ps

# Test health endpoint
curl http://localhost:3000/health

# Test scraping
curl -X POST http://localhost:3000/getmd \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

## API Endpoints

### POST /getmd

Scrape a URL and convert to markdown.

**Request:**

```bash
curl -X POST http://localhost:3000/getmd \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

**Response:**

- **Status 200**: Returns markdown content
- **Headers**:
  - `Content-Type: text/markdown; charset=utf-8`
  - `X-Page-Title`: URL-encoded page title
  - `X-Processing-Time`: Processing duration in milliseconds

**Error Responses:**

- **400**: Invalid or unsafe URL
- **429**: Rate limit exceeded
- **503**: Browser not ready
- **504**: Request timeout
- **500**: Scraping failed

### GET /health

Health check endpoint for monitoring and orchestration.

**Request:**

```bash
curl http://localhost:3000/health
```

**Response:**

```json
{
  "status": "healthy",
  "browser": "connected",
  "timestamp": "2025-11-07T08:00:00.000Z",
  "version": "1.0.0"
}
```

### GET /ready

Readiness probe for container orchestration.

**Request:**

```bash
curl http://localhost:3000/ready
```

**Response:**

```json
{
  "ready": true
}
```

## Container Management

### Stop Container

```bash
podman stop llm-md-scraper
```

### Restart Container

```bash
podman restart llm-md-scraper
```

### View Logs

```bash
# Follow logs
podman logs -f llm-md-scraper

# Last 100 lines
podman logs --tail 100 llm-md-scraper
```

### Container Health Check

```bash
podman exec llm-md-scraper curl -f http://localhost:3000/health || exit 1
```

### Remove Container

```bash
podman rm -f llm-md-scraper
```

### Using Docker Instead of Podman

All commands work with Docker by replacing `podman` with `docker`:

```bash
# Build
docker build -t llm-md-scraper .

# Run
docker run -d --name llm-md-scraper -p 3000:3000 llm-md-scraper
```

## Architecture

### Key Components

1. **Browser Management**: Single persistent Chromium instance with isolated contexts per request
2. **Content Extraction**: Mozilla Readability for clean article extraction
3. **Markdown Conversion**: Turndown with GitHub-flavored markdown support
4. **Rate Limiting**: Prevents abuse and resource exhaustion
5. **Security**: SSRF protection, input validation, security headers

### Request Flow

```
Client Request → Rate Limiter → URL Validation → Browser Context
→ Page Load → Resource Blocking → Content Extraction
→ Readability Parse → Markdown Conversion → Response
```

## Security Features

- **SSRF Protection**: Blocks private IPs and localhost
- **Protocol Validation**: Only HTTP/HTTPS allowed
- **Rate Limiting**: Configurable request limits
- **Security Headers**: Via @fastify/helmet
- **Input Validation**: JSON schema validation
- **Resource Isolation**: Separate browser contexts per request

## Performance Optimizations

- Persistent browser instance (no restart per request)
- Isolated contexts (lightweight, fast)
- Resource blocking (images, fonts, stylesheets, media)
- Connection pooling via rate limiting
- Configurable timeouts
- Efficient error handling and cleanup

## Monitoring & Logging

All requests are logged with structured data:

```json
{
  "action": "scrape_success",
  "url": "https://example.com",
  "requestId": "req-1",
  "duration": 1234,
  "titleLength": 50,
  "contentLength": 5000
}
```

Error logs include full context:

```json
{
  "action": "scrape_error",
  "error": "Navigation timeout",
  "stack": "...",
  "url": "https://example.com",
  "requestId": "req-1",
  "duration": 30000,
  "timestamp": "2025-11-07T08:00:00.000Z"
}
```

## Graceful Shutdown

The service handles SIGINT and SIGTERM signals gracefully:

1. Stops accepting new requests
2. Closes browser instance
3. Closes Fastify server
4. Exits cleanly

## Troubleshooting

### Browser fails to launch

- Ensure Playwright browsers are installed: `npx playwright install chromium`
- Check system dependencies for Chromium
- Verify `--no-sandbox` flags in Docker/Podman

### Rate limit errors

- Increase `RATE_LIMIT_MAX` in environment variables
- Adjust `RATE_LIMIT_WINDOW` for longer time windows

### Timeout errors

- Increase `PAGE_TIMEOUT` for slower pages
- Increase `REQUEST_TIMEOUT` for overall request time
- Check network connectivity to target URLs

### Memory issues

- Reduce concurrent requests via rate limiting
- Monitor browser memory usage
- Ensure proper context cleanup (automatic)

## Local Development (Without Container)

If you need to run the service locally without containers for development:

### Prerequisites

```bash
# Install Playwright browsers
npx playwright install chromium
```

### Install Dependencies

```bash
npm install
```

### Run Locally

```bash
# With default settings
npm start

# Or with custom environment
cp .env.example .env
nano .env
npm start
```

### Testing the API

```bash
# Basic test
curl -X POST http://localhost:3000/getmd \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

# Health check
curl http://localhost:3000/health

# Readiness check
curl http://localhost:3000/ready
```

**Note:** For production use, always run in containers as they include all necessary system dependencies for Playwright.

## License

MIT

## Version

1.0.0 - First release with enhanced security, performance, and reliability features.
