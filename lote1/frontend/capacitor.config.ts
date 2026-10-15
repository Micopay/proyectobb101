import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.micopay.app',
  appName: 'Micopay',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};


export default config;
