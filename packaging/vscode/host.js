'use strict';

// The VS Code extension host shim's pure helpers. The editor is the Rust WebAssembly
// build; this file only names files, finds Trunk's output, and fills the webview page.
// `node packaging/vscode/host.js` checks it.

const VIEW_TYPE = 'ai.storyteller.photocraft.editor';

// Kept in step with File › Open, minus brush/gradient/swatch libraries (those are not documents).
// `package.json` must list every one of these; the self-check below fails when it does not.
const EXTENSIONS = [
  'pcraft', 'pdn', 'ora', 'kra', 'krz', 'psd', 'psb', 'psdt',
  'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'gif', 'bmp', 'tga', 'ico', 'qoi', 'exr', 'hdr',
  'pbm', 'pgm', 'ppm', 'pam', 'pfm', 'dds', 'fits', 'fit', 'fts', 'dpx', 'cin',
  'heic', 'heif', 'hif', 'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'pef', 'orf', 'rw2', 'raf',
  'svg', 'svgz', 'af', 'afdesign', 'afphoto', 'afpub',
];

// 1 GiB. The page refuses anything larger (`host_file::MAX_HOST_FILE_BYTES`).
const MAX_HOST_FILE_BYTES = 1024 * 1024 * 1024;

// Trunk writes `name-<hash>.js` and `name-<hash>_bg.wasm` next to each other.
function findBuild(names) {
  const wasms = names.filter((name) => name.endsWith('_bg.wasm'));
  if (wasms.length !== 1) {
    return null;
  }
  const stem = wasms[0].slice(0, -'_bg.wasm'.length);
  const js = `${stem}.js`;
  if (!names.includes(js)) {
    return null;
  }
  return { js, wasm: wasms[0] };
}

// A single path segment. Directory pieces are dropped so a save cannot leave the opened file's folder.
function baseName(name) {
  if (typeof name !== 'string' || name.includes('\0')) {
    return null;
  }
  const parts = name.split(/[/\\]/);
  const base = parts[parts.length - 1].trim();
  if (!base || base === '.' || base === '..' || base.length > 255) {
    return null;
  }
  return base;
}

// The first filter is the one VS Code selects. The suggested file's extension leads.
function saveFilters(name) {
  const base = baseName(name) || 'Untitled.psd';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : 'psd';
  const labels = {
    psd: 'Photoshop',
    psb: 'Large Document Format',
    pcraft: 'PhotoCraft',
    ora: 'OpenRaster',
    png: 'PNG',
    jpg: 'JPEG',
    jpeg: 'JPEG',
    tif: 'TIFF',
    tiff: 'TIFF',
    webp: 'WebP',
    gif: 'GIF',
    bmp: 'BMP',
    tga: 'Targa',
    svg: 'SVG',
  };
  const extensions = ext === 'jpg' || ext === 'jpeg' ? ['jpg', 'jpeg'] : ext === 'tif' || ext === 'tiff' ? ['tif', 'tiff'] : [ext];
  return {
    [labels[ext] || 'Image']: extensions,
    'All Files': ['*'],
  };
}

// A save-dialog id or a chosen-file token: 16 random bytes, hex.
function isSaveToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

function asBytes(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

// A webview resource URL. Quotes and angle brackets would break out of the module script.
function pageAddress(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\u0000-\u001f<>"'\\]/.test(value);
}

// `webview.cspSource` is a source list, and VS Code's value is `'self' https://*.vscode-cdn.net`.
// The quotes around self are required by CSP. A double quote or semicolon would escape the attribute.
function cspSourceList(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f<>"\\;]/.test(value);
}

function editorHtml(opts) {
  const { cspSource, nonce, jsUri, wasmUri } = opts;
  if (!cspSourceList(cspSource) || !/^[0-9a-f]+$/.test(nonce) || !pageAddress(jsUri) || !pageAddress(wasmUri)) {
    return null;
  }
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} blob: data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${cspSource}`,
    `connect-src ${cspSource} blob:`,
    `worker-src blob: ${cspSource}`,
    `font-src ${cspSource} data:`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>PhotoCraft</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #262626; }
    #photocraft_canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    #photocraft_loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 0 16px; text-align: center; color: #b8b8b8; font: 14px system-ui, sans-serif; pointer-events: none; }
    #photocraft_loading p { margin: 0 0 8px; max-width: 420px; line-height: 1.5; }
    #photocraft_stalled { color: #8c8c8c; visibility: hidden; animation: photocraft-stalled 0s 20s forwards; }
    @keyframes photocraft-stalled { to { visibility: visible; } }
  </style>
</head>
<body>
  <canvas id="photocraft_canvas"></canvas>
  <div id="photocraft_loading">
    <p>Loading PhotoCraft&hellip;</p>
    <p id="photocraft_stalled">This is taking longer than usual. If PhotoCraft doesn't start, its files may have failed to
      download or come from a different version of this page. Close the editor and open the file again; the browser
      console lists what failed.</p>
  </div>
  <script type="module" nonce="${nonce}">
    import init from ${JSON.stringify(jsUri)};
    const loading = document.getElementById('photocraft_loading');
    try {
      await init(${JSON.stringify(wasmUri)});
    } catch (err) {
      if (loading) {
        loading.textContent = 'PhotoCraft failed to start: ' + (err && err.message ? err.message : err);
      }
    }
  </script>
</body>
</html>
`;
}

function missingHtml(detail) {
  const text = detail || 'This extension has no PhotoCraft web build yet. From the repository root, run packaging/vscode/package.sh, then reinstall the VSIX.';
  const escaped = String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>PhotoCraft</title>
  <style>
    body { margin: 0; background: #262626; color: #d0d0d0; font: 14px system-ui, sans-serif; }
    main { max-width: 36rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; }
    h1 { font-size: 1.1rem; font-weight: 600; }
    code { font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>PhotoCraft</h1>
    <p>${escaped}</p>
  </main>
</body>
</html>
`;
}

module.exports = {
  VIEW_TYPE,
  EXTENSIONS,
  MAX_HOST_FILE_BYTES,
  findBuild,
  baseName,
  saveFilters,
  isSaveToken,
  asBytes,
  editorHtml,
  missingHtml,
};

if (require.main === module) {
  const assert = require('assert');
  const pkg = require('./package.json');
  assert.strictEqual(baseName('dir/photo.psd'), 'photo.psd');
  assert.strictEqual(baseName('C:\\pics\\photo.PSD'), 'photo.PSD');
  assert.strictEqual(baseName('  leaf.png'), 'leaf.png');
  assert.strictEqual(baseName(''), null);
  assert.strictEqual(baseName('..'), null);
  assert.strictEqual(baseName('dir/..'), null);
  assert.strictEqual(baseName('a\0b.png'), null);
  assert.deepStrictEqual(
    findBuild(['index.html', 'photocraft-web-abc.js', 'photocraft-web-abc_bg.wasm']),
    { js: 'photocraft-web-abc.js', wasm: 'photocraft-web-abc_bg.wasm' },
  );
  assert.strictEqual(findBuild(['only.js']), null);
  assert.strictEqual(findBuild(['a_bg.wasm', 'b_bg.wasm', 'a.js', 'b.js']), null);
  assert.deepStrictEqual(saveFilters('dir/photo.PSD'), { Photoshop: ['psd'], 'All Files': ['*'] });
  assert.deepStrictEqual(saveFilters('out.png'), { PNG: ['png'], 'All Files': ['*'] });
  assert.deepStrictEqual(saveFilters('out.jpg'), { JPEG: ['jpg', 'jpeg'], 'All Files': ['*'] });
  assert.deepStrictEqual(saveFilters(''), { Photoshop: ['psd'], 'All Files': ['*'] });
  assert.strictEqual(isSaveToken('a'.repeat(32)), true);
  assert.strictEqual(isSaveToken('editor'), false);
  assert.strictEqual(isSaveToken('A'.repeat(32)), false);
  assert.strictEqual(asBytes(Uint8Array.from([4, 5])).length, 2);
  assert.strictEqual(asBytes(new ArrayBuffer(3)).length, 3);
  assert.strictEqual(asBytes({ 0: 1, 1: 2 }), null);
  const nonce = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const cspSource = "'self' https://*.vscode-cdn.net";
  const html = editorHtml({
    cspSource,
    nonce,
    jsUri: 'https://file+.vscode-resource.vscode-cdn.net/media/app.js',
    wasmUri: 'https://file+.vscode-resource.vscode-cdn.net/media/app_bg.wasm',
  });
  assert.ok(html.includes('id="photocraft_canvas"'));
  assert.ok(html.includes(`script-src 'nonce-${nonce}'`));
  assert.ok(html.includes("'self' https://*.vscode-cdn.net"));
  assert.ok(html.includes('https://file+.vscode-resource.vscode-cdn.net/media/app.js'));
  assert.ok(html.includes('https://file+.vscode-resource.vscode-cdn.net/media/app_bg.wasm'));
  assert.strictEqual(editorHtml({
    cspSource,
    nonce,
    jsUri: 'https://cdn.example/</script>.js',
    wasmUri: 'https://cdn.example/app_bg.wasm',
  }), null);
  assert.strictEqual(editorHtml({
    cspSource: `'self'; evil`,
    nonce,
    jsUri: 'https://cdn.example/app.js',
    wasmUri: 'https://cdn.example/app_bg.wasm',
  }), null);
  assert.strictEqual(pkg.contributes.customEditors[0].viewType, VIEW_TYPE);
  const manifest = JSON.stringify(pkg);
  for (const ext of EXTENSIONS) {
    assert.ok(manifest.includes(`*.${ext}`), `missing *.${ext}`);
  }
  assert.ok(manifest.includes('*.PSD'));
  assert.strictEqual(MAX_HOST_FILE_BYTES, 1024 * 1024 * 1024);
  console.log('photocraft vscode host: ok');
}
