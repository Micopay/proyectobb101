import { InMemoryStore, createRateLimiter } from '../middleware/rateLimit.middleware.js';
import { RateLimitError } from '../utils/errors.js';
import { ok, strictEqual, rejects } from 'assert';

async function testRateLimiter() {
  console.log('Running Rate Limiter Tests...');

  const store = new InMemoryStore();
  const windowMs = 1000;
  const max = 2;

  const limiter = createRateLimiter({
    windowMs,
    max,
    store,
    keyGenerator: (req) => req.ip,
  });

  const mockReq = { ip: '127.0.0.1' };
  const mockReply = {
    header: (name: string, value: any) => {
      console.log(`Setting header ${name}: ${value}`);
    },
  };

  // Hit 1
  await (limiter as any)(mockReq, mockReply);
  console.log('Hit 1: OK');

  // Hit 2
  await (limiter as any)(mockReq, mockReply);
  console.log('Hit 2: OK');

  // Hit 3 - should throw
  try {
    await (limiter as any)(mockReq, mockReply);
    throw new Error('Should have thrown RateLimitError');
  } catch (err) {
    if (err instanceof RateLimitError) {
      strictEqual(err.statusCode, 429);
      ok(err.retryAfter !== undefined);
      console.log('Hit 3: Blocked (Correct)');
    } else {
      throw err;
    }
  }

  // Wait for window to reset
  console.log('Waiting for window reset...');
  await new Promise(resolve => setTimeout(resolve, windowMs + 100));

  // Hit 4 - should be OK again
  await (limiter as any)(mockReq, mockReply);
  console.log('Hit 4: OK (Reset worked)');

  console.log('All Rate Limiter Tests Passed!');
}

testRateLimiter().catch(err => {
  console.error('Tests failed:', err);
  process.exit(1);
});
