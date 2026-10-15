import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  if (mode !== 'development' && env.VITE_DEMO_MODE === 'true') {
    throw new Error(
      `CRITICAL SECURITY ERROR: VITE_DEMO_MODE cannot be enabled in non-development builds (mode: ${mode}). ` +
      `Ensure VITE_DEMO_MODE is disabled or unset for production/testnet release builds to avoid exposing mock/demo behaviors in the APK.`
    );
  }

  return {
    base: './',
    plugins: [
      react(),
      nodePolyfills({ include: ['buffer', 'process'] }),
    ],
    server: {
      port: 5181,
      strictPort: true,
    },
  };
})
