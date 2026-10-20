import { toSupportCode } from '../middleware/requestId.middleware.js';
import { strictEqual, ok } from 'assert';

async function testSupportCode() {
  console.log('Running Support Code Tests...');

  // Test 1: deterministic output from a known UUID
  const uuid = '3f2abc91-1234-5678-9abc-def012345678';
  const code = toSupportCode(uuid);
  strictEqual(code, '3f2a-bc91', 'Support code should be first 8 hex chars with a dash');
  console.log(`  toSupportCode("${uuid}") => "${code}" ✓`);

  // Test 2: different UUIDs produce different codes
  const uuid2 = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
  const code2 = toSupportCode(uuid2);
  strictEqual(code2, 'aaaa-bbbb');
  ok(code !== code2, 'Different UUIDs should produce different support codes');
  console.log(`  toSupportCode("${uuid2}") => "${code2}" ✓`);

  // Test 3: support code length is always 9 (xxxx-xxxx)
  strictEqual(code.length, 9, 'Support code should be 9 chars (xxxx-xxxx)');
  console.log(`  code length = ${code.length} ✓`);

  // Test 4: handles UUID without dashes (edge case)
  const noDashes = '3f2abc911234567890abcdef01234567';
  const code3 = toSupportCode(noDashes);
  strictEqual(code3, '3f2a-bc91');
  console.log(`  handles raw hex input ✓`);

  console.log('All Support Code Tests Passed!');
}

async function testRequestIdIntegration() {
  console.log('\nRunning Request ID Integration Tests...');

  // Test: error response shape validation
  const errorResponse = {
    code: 'TEST_ERROR',
    message: 'Test message',
    request_id: '3f2abc91-1234-5678-9abc-def012345678',
    support_code: toSupportCode('3f2abc91-1234-5678-9abc-def012345678'),
  };

  ok(errorResponse.request_id, 'Error response should include request_id');
  ok(errorResponse.support_code, 'Error response should include support_code');
  strictEqual(errorResponse.support_code, '3f2a-bc91');
  console.log('  Error response shape valid ✓');

  // Test: support code is human-readable (only hex + dash)
  ok(/^[0-9a-f]{4}-[0-9a-f]{4}$/.test(errorResponse.support_code),
    'Support code should match xxxx-xxxx hex pattern');
  console.log('  Support code format valid ✓');

  console.log('All Request ID Integration Tests Passed!');
}

async function main() {
  await testSupportCode();
  await testRequestIdIntegration();
  console.log('\n✅ All correlation ID tests passed!');
}

main().catch(err => {
  console.error('Tests failed:', err);
  process.exit(1);
});
