// Bundles the official Anthropic TypeScript/JavaScript SDK into one browser ES module
// (vendor/anthropic-sdk.mjs) so the app stays a static site with no runtime build step
// and no third-party script origin. Run after changing the pinned SDK version:
//   npm run vendor:sdk
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../node_modules/@anthropic-ai/sdk/package.json", import.meta.url)));
await build({
  stdin: { contents: 'export { default, Anthropic, APIError, APIConnectionError, AuthenticationError, RateLimitError, BadRequestError, PermissionDeniedError, InternalServerError } from "@anthropic-ai/sdk";', resolveDir: new URL("..", import.meta.url).pathname },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
  external: ["node:*"],
  outfile: new URL("../vendor/anthropic-sdk.mjs", import.meta.url).pathname,
  banner: { js: `// @anthropic-ai/sdk ${pkg.version} (MIT) bundled for the browser by scripts/vendor-sdk.js` },
  logLevel: "warning",
});
console.log("vendor/anthropic-sdk.mjs built from @anthropic-ai/sdk " + pkg.version);
