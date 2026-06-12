import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://meshwhisper.org',
  integrations: [tailwind()],
  output: 'static',
});
