require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const { chromium } = require('playwright');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

// ========================================
// CONFIGURATION CONSTANTS
// ========================================
const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || '30000');
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '45000');
const BROWSER_HEADLESS = process.env.BROWSER_HEADLESS !== 'false';
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10');
const RATE_LIMIT_WINDOW = process.env.RATE_LIMIT_WINDOW || '1 minute';
const BROWSER_LAUNCH_MAX_RETRIES = parseInt(process.env.BROWSER_LAUNCH_MAX_RETRIES || '3');
const BLOCK_RESOURCES = process.env.BLOCK_RESOURCES !== 'false'; // Images, fonts, etc.

// ========================================
// GLOBAL STATE
// ========================================
let browser;

// ========================================
// TURNDOWN CONFIGURATION
// ========================================
const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
});
turndownService.use(gfm);

// ========================================
// URL VALIDATION (with SSRF Protection)
// ========================================
/**
 * Validates URL and prevents SSRF attacks
 * @param {string} string - The URL to validate
 * @returns {boolean} - True if valid and safe
 */
function isValidUrl(string) {
    try {
        const url = new URL(string);
        
        // Only allow HTTP/HTTPS protocols
        if (!['http:', 'https:'].includes(url.protocol)) {
            return false;
        }
        
        // Prevent SSRF attacks - block localhost and private IPs
        const hostname = url.hostname.toLowerCase();
        const blockedHosts = [
            'localhost',
            '127.0.0.1',
            '0.0.0.0',
            '::1',
            '[::1]'
        ];
        
        if (blockedHosts.includes(hostname)) {
            return false;
        }
        
        // Block private IP ranges (basic check)
        if (hostname.startsWith('10.') || 
            hostname.startsWith('192.168.') ||
            hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
            return false;
        }
        
        return true;
    } catch (_) {
        return false;
    }
}

// ========================================
// BROWSER MANAGEMENT
// ========================================
/**
 * Launch browser with retry logic
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<Browser>} - Playwright browser instance
 */
async function launchBrowserWithRetry(maxRetries = BROWSER_LAUNCH_MAX_RETRIES) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Browser launch attempt ${attempt}/${maxRetries}...`);
            
            const browserInstance = await chromium.launch({
                headless: BROWSER_HEADLESS,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-extensions'
                ]
            });
            
            console.log('✓ Browser launched successfully');
            return browserInstance;
            
        } catch (error) {
            console.error(`✗ Browser launch attempt ${attempt} failed:`, error.message);
            
            if (attempt === maxRetries) {
                throw new Error(`Failed to launch browser after ${maxRetries} attempts: ${error.message}`);
            }
            
            // Exponential backoff
            const delay = 1000 * attempt;
            console.log(`  Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// ========================================
// PAGE PROCESSING
// ========================================
/**
 * Process a page and extract markdown content
 * @param {Page} page - Playwright page instance
 * @param {string} url - URL to process
 * @returns {Promise<{markdown: string, title: string}>}
 */
async function processPage(page, url) {
    // Block unnecessary resources for faster loading
    if (BLOCK_RESOURCES) {
        await page.route('**/*', (route) => {
            const resourceType = route.request().resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                route.abort();
            } else {
                route.continue();
            }
        });
    }
    
    await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: PAGE_TIMEOUT 
    });
    
    const rawHtml = await page.content();
    const doc = new JSDOM(rawHtml, { url: url });
    const reader = new Readability(doc.window.document);
    const article = reader.parse();

    if (!article) {
        throw new Error("Readability failed to parse the page.");
    }

    const markdown = turndownService.turndown(article.content);
    return { markdown, title: article.title };
}

// ========================================
// FASTIFY PLUGINS & MIDDLEWARE
// ========================================
async function registerPlugins() {
    // Security headers
    await fastify.register(require('@fastify/helmet'), {
        contentSecurityPolicy: false // Disable CSP since we're an API
    });

    // CORS support (if needed for browser access)
    await fastify.register(require('@fastify/cors'), {
        origin: process.env.CORS_ORIGIN || false
    });

    // Rate limiting
    await fastify.register(require('@fastify/rate-limit'), {
        max: RATE_LIMIT_MAX,
        timeWindow: RATE_LIMIT_WINDOW,
        errorResponseBuilder: () => ({
            error: 'Rate limit exceeded',
            message: `Maximum ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW}`
        })
    });
}

// ========================================
// ROUTES
// ========================================

// Health check endpoint
fastify.get('/health', async (request, reply) => {
    const browserReady = browser && browser.isConnected();
    
    return reply.code(browserReady ? 200 : 503).send({
        status: browserReady ? 'healthy' : 'unhealthy',
        browser: browserReady ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
        version: require('./package.json').version
    });
});

// Readiness probe (stricter health check)
fastify.get('/ready', async (request, reply) => {
    const browserReady = browser && browser.isConnected();
    
    if (!browserReady) {
        return reply.code(503).send({
            ready: false,
            reason: 'Browser not connected'
        });
    }
    
    return reply.send({ ready: true });
});

// Request body schema for validation
const scrapRequestSchema = {
    body: {
        type: 'object',
        required: ['url'],
        properties: {
            url: { 
                type: 'string',
                minLength: 1,
                maxLength: 2048
            }
        }
    }
};

// Main scraping endpoint
fastify.post('/getmd', {
    schema: scrapRequestSchema,
    config: {
        timeout: REQUEST_TIMEOUT
    }
}, async (request, reply) => {
    const { url } = request.body;
    const requestId = request.id;
    const startTime = Date.now();

    // Validate URL
    if (!isValidUrl(url)) {
        return reply.code(400).send({ 
            error: "Invalid or unsafe URL",
            details: "URL must use HTTP/HTTPS protocol and cannot target private networks"
        });
    }

    // Check browser availability
    if (!browser || !browser.isConnected()) {
        return reply.code(503).send({ 
            error: "Browser not ready",
            details: "The browser service is currently unavailable"
        });
    }

    let context;
    let page;
    
    try {
        request.log.info({
            action: 'scrape_start',
            url: url,
            requestId: requestId
        });

        // Create isolated browser context with optimized settings
        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (compatible; LLM-MD-Scraper/1.0)',
            viewport: { width: 1280, height: 720 },
            ignoreHTTPSErrors: true,
            javaScriptEnabled: true,
            acceptDownloads: false,
            hasTouch: false,
        });
        
        page = await context.newPage();

        const { markdown, title } = await processPage(page, url);

        const duration = Date.now() - startTime;
        request.log.info({
            action: 'scrape_success',
            url: url,
            requestId: requestId,
            duration: duration,
            titleLength: title?.length || 0,
            contentLength: markdown.length
        });

        // Send metadata as headers, body as raw markdown
        reply.header('Content-Type', 'text/markdown; charset=utf-8');
        reply.header('X-Page-Title', encodeURIComponent(title || 'Untitled'));
        reply.header('X-Processing-Time', duration.toString());
        
        return markdown;

    } catch (error) {
        const duration = Date.now() - startTime;
        
        request.log.error({
            action: 'scrape_error',
            error: error.message,
            stack: error.stack,
            url: url,
            requestId: requestId,
            duration: duration,
            timestamp: new Date().toISOString()
        });
        
        // Determine appropriate status code
        let statusCode = 500;
        if (error.message.includes('timeout')) {
            statusCode = 504;
        } else if (error.message.includes('net::')) {
            statusCode = 502;
        }
        
        return reply.code(statusCode).send({
            error: "Scraping failed",
            details: error.message,
            url: url,
            requestId: requestId
        });
        
    } finally {
        // Cleanup resources
        if (page) {
            try {
                await page.close();
            } catch (err) {
                request.log.warn('Failed to close page:', err.message);
            }
        }
        if (context) {
            try {
                await context.close();
            } catch (err) {
                request.log.warn('Failed to close context:', err.message);
            }
        }
    }
});

// ========================================
// SERVER LIFECYCLE
// ========================================
const start = async () => {
    try {
        // Register plugins
        await registerPlugins();
        
        // Launch browser with retry logic
        console.log("Launching headless browser...");
        browser = await launchBrowserWithRetry();
        console.log("✓ Browser ready");

        // Start listening
        await fastify.listen({ port: PORT, host: HOST });
        console.log(`✓ Server running at http://${HOST}:${PORT}`);
        console.log(`✓ Health check: http://${HOST}:${PORT}/health`);
        console.log(`✓ Rate limit: ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW}`);
        
    } catch (err) {
        fastify.log.error('Failed to start server:', err);
        process.exit(1);
    }
};

// ========================================
// GRACEFUL SHUTDOWN
// ========================================
async function gracefulShutdown(signal) {
    console.log(`\n${signal} received, shutting down gracefully...`);
    
    try {
        // Close browser first
        if (browser) {
            console.log('Closing browser...');
            await browser.close();
            console.log('✓ Browser closed');
        }
        
        // Close Fastify server
        console.log('Closing server...');
        await fastify.close();
        console.log('✓ Server closed');
        
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
}

// Handle termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit in production, just log
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // In production, you might want to gracefully shutdown here
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// ========================================
// START SERVER
// ========================================
start();
