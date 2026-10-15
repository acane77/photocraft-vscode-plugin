'use strict';

// VS Code / code-server host for the PhotoCraft web build.
// The editor is the Rust app compiled to WebAssembly (apps/photocraft-web). This file only
// opens that page in a custom editor, hands it the workspace file, and writes saves back.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vscode = require('vscode');
const host = require('./host');

function activate(context) {
  const provider = new PhotoCraftProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(host.VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('photocraft.save', () => provider.saveActive()),
  );
}

function deactivate() {}

class PhotoCraftProvider {
  constructor(context) {
    this.context = context;
    this.active = null;
  }

  openCustomDocument(uri) {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(document, panel) {
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const fileRoot = vscode.Uri.joinPath(document.uri, '..');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaUri, fileRoot],
    };

    const session = { panel, document, nonce: null, inlineTried: false, saves: new Map() };
    const name = host.baseName(path.posix.basename(document.uri.path));
    const markActive = () => {
      if (panel.active) {
        this.active = session;
      }
    };
    panel.onDidChangeViewState(markActive);
    markActive();
    panel.onDidDispose(() => {
      if (this.active === session) {
        this.active = null;
      }
    });

    const subscription = panel.webview.onDidReceiveMessage((msg) => {
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.type === 'ready' && typeof msg.nonce === 'string' && msg.nonce.length === 32) {
        session.nonce = msg.nonce;
        if (!name) {
          void vscode.window.showErrorMessage('PhotoCraft: missing file name');
          return;
        }
        const url = panel.webview.asWebviewUri(document.uri).toString();
        void panel.webview.postMessage({ type: 'open', nonce: session.nonce, name, url });
        return;
      }
      if (msg.type === 'need-bytes') {
        void this.sendBytes(session, name);
        return;
      }
      if (msg.type === 'save-dialog') {
        void this.saveDialog(session, msg);
        return;
      }
      if (msg.type === 'write') {
        void this.writeBytes(session, msg);
        return;
      }
      if (msg.type === 'error' && typeof msg.message === 'string' && msg.message) {
        void vscode.window.showErrorMessage(`PhotoCraft: ${msg.message}`);
      }
    });
    panel.onDidDispose(() => subscription.dispose());

    const built = readBuild(mediaUri);
    if (!built) {
      panel.webview.html = host.missingHtml();
      return;
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    const html = host.editorHtml({
      cspSource: panel.webview.cspSource,
      nonce,
      jsUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, built.js)).toString(),
      wasmUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, built.wasm)).toString(),
    });
    panel.webview.html = html || host.missingHtml('PhotoCraft could not address its web build inside this editor.');
  }

  saveActive() {
    const session = this.active;
    if (!session || !session.nonce) {
      void vscode.window.showErrorMessage('PhotoCraft is still loading this file.');
      return;
    }
    void session.panel.webview.postMessage({ type: 'save', nonce: session.nonce });
  }

  async sendBytes(session, name) {
    if (!session.nonce || !name) {
      return;
    }
    if (session.inlineTried) {
      void vscode.window.showErrorMessage('PhotoCraft could not read this file.');
      return;
    }
    session.inlineTried = true;
    try {
      const data = await vscode.workspace.fs.readFile(session.document.uri);
      if (data.byteLength > host.MAX_HOST_FILE_BYTES) {
        void vscode.window.showErrorMessage('PhotoCraft: file is too large');
        return;
      }
      await session.panel.webview.postMessage({
        type: 'open-bytes',
        nonce: session.nonce,
        name,
        data,
      });
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      void vscode.window.showErrorMessage(`PhotoCraft could not read this file: ${detail}`);
    }
  }

  async saveDialog(session, msg) {
    const id = host.isSaveToken(msg && msg.id) ? msg.id : null;
    if (!id || !session.nonce) {
      return;
    }
    const suggested = host.baseName(msg.suggested) || 'Untitled.psd';
    const finish = (fields) => {
      void session.panel.webview.postMessage({ type: 'save-dialog-result', nonce: session.nonce, id, ...fields });
    };
    let picked;
    try {
      picked = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(session.document.uri, '..', suggested),
        filters: host.saveFilters(suggested),
        saveLabel: 'Save',
      });
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      void vscode.window.showErrorMessage(`PhotoCraft could not open the save dialog: ${detail}`);
      finish({ cancelled: true });
      return;
    }
    if (!picked) {
      finish({ cancelled: true });
      return;
    }
    const name = host.baseName(path.posix.basename(picked.path));
    if (!name) {
      void vscode.window.showErrorMessage('PhotoCraft could not use the chosen file.');
      finish({ cancelled: true });
      return;
    }
    const token = crypto.randomBytes(16).toString('hex');
    session.saves.set(token, picked);
    finish({ token, name });
  }

  async writeBytes(session, msg) {
    const dest = msg && msg.dest;
    const base = host.baseName(msg && msg.name);
    const bytes = host.asBytes(msg && msg.data);
    if (!base || !bytes || bytes.byteLength === 0) {
      void vscode.window.showErrorMessage('PhotoCraft could not save: the file was empty or unnamed.');
      return;
    }
    if (bytes.byteLength > host.MAX_HOST_FILE_BYTES) {
      void vscode.window.showErrorMessage('PhotoCraft: file is too large to save');
      return;
    }
    let target;
    if (dest === 'editor') {
      target = session.document.uri;
    } else if (host.isSaveToken(dest)) {
      target = session.saves.get(dest) || null;
    }
    if (!target) {
      void vscode.window.showErrorMessage('PhotoCraft could not save: choose a file in the save dialog.');
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(target, bytes);
      const saved = host.baseName(path.posix.basename(target.path)) || base;
      void vscode.window.setStatusBarMessage(`PhotoCraft saved ${saved}`, 3000);
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      void vscode.window.showErrorMessage(`PhotoCraft could not save ${base}: ${detail}`);
    }
  }
}

function readBuild(mediaUri) {
  let names;
  try {
    names = fs.readdirSync(mediaUri.fsPath);
  } catch (_err) {
    return null;
  }
  return host.findBuild(names);
}

module.exports = { activate, deactivate };
