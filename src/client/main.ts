import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/fira-code/latin-400.css';
import '@fontsource/fira-code/latin-500.css';
import '@fontsource/source-code-pro/latin-400.css';
import '@fontsource/source-code-pro/latin-500.css';
import '@fontsource/cascadia-code/latin-400.css';
import '@fontsource/cascadia-code/latin-500.css';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createApp } from 'vue';
import App from './App.vue';
import { shouldRetryApiQuery } from './api';
import { applyTheme, readCachedTheme } from './appearance';
import './styles.css';
import './operation-dialog.css';

// 先按本地缓存落主题，避免刷新时用默认色板闪一下；服务端配置回来后由 App 接管。
applyTheme(readCachedTheme());
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetryApiQuery,
    },
  },
});
createApp(App).use(VueQueryPlugin, { queryClient }).mount('#app');
