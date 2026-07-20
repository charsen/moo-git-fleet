import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

document.documentElement.dataset.theme = 'moon';
createApp(App).use(VueQueryPlugin).mount('#app');
