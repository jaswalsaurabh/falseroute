import type { Configuration } from 'lint-staged';

const config: Configuration = {
  '*.{ts,tsx,js,mjs,cjs}': ['prettier --write --ignore-unknown', 'oxlint --deny-warnings'],
  '*.{json,jsonc,yaml,yml,md,css,scss,html}': ['prettier --write --ignore-unknown'],
};

export default config;
