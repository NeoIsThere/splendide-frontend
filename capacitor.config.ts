import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.splendide.mobile',
  appName: 'Splendide',
  webDir: 'dist/splendide/browser',
  backgroundColor: '#fafafa',
  ios: {
    // CSS owns the safe-area padding. Automatic UIKit insets would apply it a
    // second time and make the WebView appear letterboxed.
    contentInset: 'never',
  },
  android: {
    allowMixedContent: false,
  },
  experimental: {
    ios: {
      spm: {
        packageOptions: {
          '@capacitor-firebase/messaging': { symlink: true },
        },
      },
    },
  },
  plugins: {
    Keyboard: {
      // iOS owns keyboard resizing at the native WebView layer. Android uses
      // adjustResize plus Capacitor 8's SystemBars inset handling below.
      resize: 'native',
    },
    SystemBars: {
      // Capacitor injects --safe-area-inset-* on Android WebView versions that
      // do not yet expose correct env(safe-area-inset-*) values.
      insetsHandling: 'css',
      style: 'LIGHT',
      hidden: false,
      animation: 'NONE',
    },
    FirebaseMessaging: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SocialLogin: {
      providers: {
        google: true,
        apple: true,
        facebook: false,
        twitter: false,
      },
      logLevel: 1,
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 800,
      backgroundColor: '#fafafa',
      showSpinner: false,
    },
    StatusBar: {
      // Keeps Android <= 14 and iOS edge-to-edge. Android 15+ enforces this.
      overlaysWebView: true,
      style: 'LIGHT',
    },
  },
};

export default config;
