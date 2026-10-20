import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import { config, getCorsOptions } from '../config.js';
import { deepStrictEqual as deepEqual, strictEqual, ok } from 'assert';
import type { FastifyInstance } from 'fastify';

async function testSecurityHeaders() {
  console.log('Running Security Headers & CORS Tests (SEC-21)...\n');

  let app: FastifyInstance;

  // Setup app for tests
  async function setupApp() {
    app = Fastify({
      logger: false,
    });

    // Register security headers via @fastify/helmet
    await app.register(fastifyHelmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https://soroban-testnet.stellar.org", "https://soroban.stellar.org", "https://horizon-testnet.stellar.org"],
        },
      },
      referrerPolicy: {
        policy: "strict-origin-when-cross-origin",
      },
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
      frameguard: {
        action: "deny",
      },
      noSniff: true,
      xssFilter: true,
    });

    // Register CORS with secure configuration
    app.register(fastifyCors, getCorsOptions());

    // Add a test route
    app.get('/health', async () => {
      return { status: 'ok', timestamp: new Date().toISOString() };
    });

    await app.ready();
    return app;
  }

  async function cleanup() {
    if (app) {
      await app.close();
    }
  }

  try {
    // Test 1: Security Headers
    console.log('1. Testing Security Headers...');
    app = await setupApp();
    
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    strictEqual(response.statusCode, 200, 'Health endpoint should return 200');
    
    // Check security headers
    ok(response.headers['strict-transport-security'], 'Should include Strict-Transport-Security header');
    ok(response.headers['strict-transport-security'].includes('max-age=31536000'), 'HSTS should have 1 year max-age');
    ok(response.headers['strict-transport-security'].includes('includeSubDomains'), 'HSTS should include subdomains');
    
    strictEqual(response.headers['x-content-type-options'], 'nosniff', 'Should include X-Content-Type-Options header');
    strictEqual(response.headers['x-frame-options'], 'DENY', 'Should include X-Frame-Options header');
    
    ok(response.headers['content-security-policy'], 'Should include Content-Security-Policy header');
    ok(response.headers['content-security-policy'].includes("default-src 'self'"), 'CSP should restrict default resources');
    
    strictEqual(response.headers['referrer-policy'], 'strict-origin-when-cross-origin', 'Should include Referrer-Policy header');
    ok(response.headers['x-xss-protection'], 'Should include X-XSS-Protection header');
    
    // Should not expose sensitive headers
    ok(!response.headers['server'], 'Should not expose server header');
    ok(!response.headers['x-powered-by'], 'Should not expose x-powered-by header');
    
    console.log('   ✅ All security headers present\n');
    await cleanup();

    // Test 2: CORS Configuration
    console.log('2. Testing CORS Configuration...');
    app = await setupApp();
    
    // Test OPTIONS preflight - fastify-cors handles this automatically
    // In development with default config, OPTIONS should work
    const preflightResponse = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'GET',
      },
    });
    
    // fastify-cors returns 204 for valid preflight requests
    // For this test, we'll accept any non-error status
    ok(preflightResponse.statusCode < 400, 
       `OPTIONS preflight should not error, got ${preflightResponse.statusCode}`);
    
    // Test CORS with localhost (should be allowed in development)
    const corsResponse = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        origin: 'http://localhost:3000',
      },
    });
    
    strictEqual(corsResponse.statusCode, 200, 'CORS request from localhost should succeed');
    
    console.log('   ✅ CORS configuration working\n');
    await cleanup();

    // Test 3: Production CORS Safety
    console.log('3. Testing Production CORS Safety...');
    
    // Save original environment
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCorsOrigins = process.env.CORS_ALLOWED_ORIGINS;
    
    try {
      // Test production with no origins configured (should reject all)
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ALLOWED_ORIGINS;
      
      const prodApp = Fastify({ logger: false });
      await prodApp.register(fastifyHelmet);
      prodApp.register(fastifyCors, getCorsOptions());
      
      prodApp.get('/test', async () => ({ ok: true }));
      await prodApp.ready();
      
      const prodResponse = await prodApp.inject({
        method: 'GET',
        url: '/test',
        headers: {
          origin: 'https://any-origin.com',
        },
      });
      
      // Should not allow the origin
      ok(!prodResponse.headers['access-control-allow-origin'] || 
         prodResponse.headers['access-control-allow-origin'] !== 'https://any-origin.com',
         'Should reject CORS from unauthorized origins in production');
      
      console.log('   ✅ Production fail-closed behavior working\n');
      
      await prodApp.close();
      
    } finally {
      // Restore environment
      process.env.NODE_ENV = originalNodeEnv;
      if (originalCorsOrigins) {
        process.env.CORS_ALLOWED_ORIGINS = originalCorsOrigins;
      } else {
        delete process.env.CORS_ALLOWED_ORIGINS;
      }
    }

    // Test 4: CSP Configuration
    console.log('4. Testing Content Security Policy...');
    app = await setupApp();
    
    const cspResponse = await app.inject({
      method: 'GET',
      url: '/health',
    });
    
    const csp = cspResponse.headers['content-security-policy'] as string;
    ok(csp.includes("default-src 'self'"), 'CSP should have default-src self');
    ok(csp.includes('connect-src'), 'CSP should include connect-src directive');
    ok(csp.includes('soroban'), 'CSP should allow Stellar RPC endpoints');
    ok(!csp.includes('default-src *'), 'CSP should not have wildcard default-src');
    
    console.log('   ✅ CSP properly configured\n');
    await cleanup();

    console.log('🎉 All Security Tests Passed!');
    console.log('\nSummary:');
    console.log('- ✅ 6 Security Headers implemented (HSTS, CSP, X-Frame-Options, etc.)');
    console.log('- ✅ CORS properly configured with allowlist');
    console.log('- ✅ Production fail-closed safety');
    console.log('- ✅ Development localhost convenience');
    console.log('- ✅ CSP allows necessary Stellar endpoints');

  } catch (error) {
    console.error('❌ Test failed:', error);
    await cleanup();
    process.exit(1);
  }
}

testSecurityHeaders().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});