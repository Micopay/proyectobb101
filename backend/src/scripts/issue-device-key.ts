import { issueDeviceKey } from '../utils/issueDeviceKey.js';

async function main() {
  const args = process.argv.slice(2);
  const nameArg = args.find((a) => !a.startsWith('--')) || 'Coffee Payments POS';

  try {
    const result = await issueDeviceKey(nameArg);
    console.log('\n✅ Device Key Issued Successfully!');
    console.log('----------------------------------------');
    console.log(`Device ID:   ${result.id}`);
    console.log(`Device Name: ${result.name}`);
    console.log(`Device Key:  ${result.token}`);
    console.log('----------------------------------------');
    console.log('⚠️  Store this token securely! It will NOT be shown again.\n');
    process.exit(0);
  } catch (err: any) {
    console.error('❌ Failed to issue device key:', err.message);
    process.exit(1);
  }
}

main();
