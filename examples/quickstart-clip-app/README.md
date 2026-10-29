# Quick start in your own app folder (npm)

The same one-button clip as [`../quickstart-clip-browser.html`](../quickstart-clip-browser.html), written for a folder
where you installed the SDK from npm (that file imports the repo's own `../dist/browser.js` instead).

1. In your app folder: `npm install @hapbeat/sdk` (`playClipUrl` needs 0.4.0 or later).
2. Copy [`index.html`](./index.html) and [`hit_80hz.wav`](./hit_80hz.wav) into it.
3. Run hapbeat-helper on this PC (`pip install hapbeat-helper`, then `hapbeat-helper`).
4. Serve the folder over HTTP (`npx serve`, or `python -m http.server`; `file://` cannot load ES modules) and open
   `index.html`. Press **Hit**.

The importmap points `@hapbeat/sdk` at `./node_modules/@hapbeat/sdk/dist/browser.js` (it only imports files next to
it). With a bundler (Vite, webpack, ...) remove the importmap: `import { connect } from "@hapbeat/sdk"` resolves from
`node_modules` by itself.
