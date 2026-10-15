# PhotoCraft in VS Code and code-server

The extension opens PSD files and other images in a custom editor. The editor is the existing
PhotoCraft web build (`apps/photocraft-web`, Rust compiled to WebAssembly). This directory is
only the host VS Code needs: a custom editor, the opened file, and saves written back to the
workspace. It is not a second copy of the editor.

## Install on code-server

From the repository root:

```sh
packaging/vscode/package.sh
code-server --install-extension dist/release/photocraft-<version>.vsix
```

Reload the window. Opening a `.psd` (or another associated format) starts PhotoCraft in the
editor. File › Save inside PhotoCraft, and Ctrl+S / Cmd+S while that editor is focused, write
the file back. Saving under a different name writes a sibling of the opened file.

`--skip-build` packs an existing `dist/web` from `trunk build --release` in `apps/photocraft-web`.
The script needs `trunk`, the `wasm32-unknown-unknown` target, and `node` (it runs `npx @vscode/vsce`).

The same VSIX installs in desktop VS Code. The extension runs in the workspace extension host,
which is the code-server machine, so it can read the file you opened.

## What the browser must provide

PhotoCraft draws with WebGPU when the browser has it, and WebGL2 otherwise. code-server's page
has to be opened in a browser that can do one of those. The app does not need cross-origin
isolation. Plain HTTP is enough for WebGL2; WebGPU needs a secure context (`https://` or
`http://localhost`).

## Formats

PSD, PSB, PhotoCraft (`.pcraft`), OpenRaster, Krita, Affinity, SVG, and the flat and camera-raw
formats File › Open already accepts. Brush, gradient, and swatch libraries are left to the
normal text or binary view. On Linux the match is case-sensitive, so both `*.psd` and `*.PSD`
are registered for the formats people usually meet in either case.

VS Code's image preview is no longer the default for those types. Change
`workbench.editorAssociations` if you want the preview back for one of them, and use
Open With… › PhotoCraft when you want the editor.

## Without a packed web build

Opening a file shows how to build the VSIX. The extension does not download the app.
