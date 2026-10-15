//! VS Code / code-server channel.
//!
//! The extension loads this page in a custom-editor webview and posts the opened file.
//! Ordinary browser sessions have no `acquireVsCodeApi`, so this installs nothing and
//! saving keeps the normal download. Messages are ignored unless they echo the nonce
//! issued at startup, which only the extension received.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use js_sys::Reflect;
use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;

use crate::host_file::{self, MAX_HOST_FILE_BYTES};

/// Files waiting to be opened, and a save asked for by the editor host (Ctrl+S).
pub struct HostBridge {
    opens: Mutex<Vec<(String, Vec<u8>)>>,
    save: AtomicBool,
    save_name: Mutex<Option<String>>,
}

impl HostBridge {
    fn new() -> Self {
        Self { opens: Mutex::new(Vec::new()), save: AtomicBool::new(false), save_name: Mutex::new(None) }
    }

    pub fn take_opens(&self) -> Vec<(String, Vec<u8>)> {
        let mut queue = self.opens.lock().unwrap_or_else(|err| err.into_inner());
        std::mem::take(&mut *queue)
    }

    pub fn take_save(&self) -> bool {
        self.save.swap(false, Ordering::Relaxed)
    }

    pub fn save_name(&self) -> Option<String> {
        self.save_name.lock().unwrap_or_else(|err| err.into_inner()).clone()
    }

    fn queue_open(&self, name: String, bytes: Vec<u8>) {
        *self.save_name.lock().unwrap_or_else(|err| err.into_inner()) = Some(name.clone());
        self.opens.lock().unwrap_or_else(|err| err.into_inner()).push((name, bytes));
    }

    fn request_save(&self) {
        self.save.store(true, Ordering::Relaxed);
    }
}

thread_local! {
    static VSCODE: std::cell::RefCell<Option<JsValue>> = const { std::cell::RefCell::new(None) };
    /// `acquireVsCodeApi` may be called only once. A missing function must not be probed again
    /// after a failed call, and a successful call is cached above.
    static VSCODE_TRIED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Install the channel when this page is a VS Code webview. Otherwise return a bridge
/// that never receives anything.
pub fn install(ctx: egui::Context) -> Arc<HostBridge> {
    let bridge = Arc::new(HostBridge::new());
    let Some(api) = vscode_api() else { return bridge };
    let Some(nonce) = random_nonce() else {
        post(&api, &message("error", &[("message", &JsValue::from_str("PhotoCraft could not start its editor channel"))]));
        return bridge;
    };
    if !listen(bridge.clone(), ctx, &api, nonce.clone()) {
        return bridge;
    }
    post(&api, &message("ready", &[("nonce", &JsValue::from_str(&nonce))]));
    bridge
}

/// Hand `bytes` to the extension instead of a browser download. `false` outside VS Code,
/// so the caller falls back to the download.
pub fn publish(path: &str, bytes: &[u8]) -> bool {
    let Some(api) = vscode_api() else { return false };
    if bytes.len() > MAX_HOST_FILE_BYTES {
        notify_error("file is too large to save");
        return true;
    }
    let Ok(name) = host_file::host_file_name(path) else {
        notify_error("missing file name");
        return true;
    };
    let data = js_sys::Uint8Array::from(bytes);
    post(&api, &message("write", &[("name", &JsValue::from_str(&name)), ("data", &data)]))
}

pub fn notify_error(message_text: &str) {
    log::error!("photocraft-web: {message_text}");
    let Some(api) = vscode_api() else { return };
    post(&api, &message("error", &[("message", &JsValue::from_str(message_text))]));
}

fn listen(bridge: Arc<HostBridge>, ctx: egui::Context, api: &JsValue, nonce: String) -> bool {
    let Some(window) = web_sys::window() else { return false };
    let api = api.clone();
    let callback = wasm_bindgen::closure::Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
        on_message(&bridge, &ctx, &api, &nonce, event.data());
    });
    let Ok(()) = window.add_event_listener_with_callback("message", callback.as_ref().unchecked_ref()) else {
        return false;
    };
    callback.forget();
    true
}

fn on_message(bridge: &Arc<HostBridge>, ctx: &egui::Context, api: &JsValue, nonce: &str, data: JsValue) {
    let Some(kind) = string_field(&data, "type") else { return };
    let echoed = string_field(&data, "nonce").unwrap_or_default();
    if !host_file::same_nonce(nonce, &echoed) {
        return;
    }
    match kind.as_str() {
        "open" => open_from_url(bridge, ctx, api, &data),
        "open-bytes" => open_from_bytes(bridge, ctx, &data),
        "save" => {
            bridge.request_save();
            ctx.request_repaint();
        }
        _ => {}
    }
}

fn open_from_url(bridge: &Arc<HostBridge>, ctx: &egui::Context, api: &JsValue, data: &JsValue) {
    let Some(name) = string_field(data, "name") else { return };
    let Some(url) = string_field(data, "url") else { return };
    let Ok(name) = host_file::host_file_name(&name) else {
        notify_error("missing file name");
        return;
    };
    if !host_file::allowed_host_url(&url) {
        notify_error("refused file address");
        return;
    }
    let bridge = Arc::clone(bridge);
    let ctx = ctx.clone();
    let api = api.clone();
    wasm_bindgen_futures::spawn_local(async move {
        match super::fetch_capped(&url, MAX_HOST_FILE_BYTES).await {
            Ok(bytes) => accept_open(&bridge, &ctx, name, bytes),
            Err(err) if err.contains("too large") => notify_error(&err),
            Err(err) => {
                log::info!("photocraft-web: webview fetch failed ({err}); asking the extension to pass the bytes");
                post(&api, &message("need-bytes", &[]));
            }
        }
    });
}

fn open_from_bytes(bridge: &HostBridge, ctx: &egui::Context, data: &JsValue) {
    let Some(name) = string_field(data, "name") else { return };
    let Ok(name) = host_file::host_file_name(&name) else {
        notify_error("missing file name");
        return;
    };
    let Ok(bytes_value) = Reflect::get(data, &JsValue::from_str("data")) else {
        notify_error("the editor host sent no file bytes");
        return;
    };
    match bytes_of(bytes_value) {
        Ok(bytes) => accept_open(bridge, ctx, name, bytes),
        Err(err) => notify_error(&err),
    }
}

fn accept_open(bridge: &HostBridge, ctx: &egui::Context, name: String, bytes: Vec<u8>) {
    if bytes.is_empty() {
        notify_error("empty file");
        return;
    }
    if bytes.len() > MAX_HOST_FILE_BYTES {
        notify_error("file is too large");
        return;
    }
    log::info!("photocraft-web: host opened {name} ({} bytes)", bytes.len());
    bridge.queue_open(name, bytes);
    ctx.request_repaint();
}

fn bytes_of(data: JsValue) -> Result<Vec<u8>, String> {
    let array = if let Ok(array) = data.clone().dyn_into::<js_sys::Uint8Array>() {
        array
    } else if let Ok(buffer) = data.dyn_into::<js_sys::ArrayBuffer>() {
        js_sys::Uint8Array::new(&buffer)
    } else {
        return Err("the editor host sent the file in an unsupported form".into());
    };
    let len = array.length() as usize;
    if len == 0 {
        return Err("empty file".into());
    }
    if len > MAX_HOST_FILE_BYTES {
        return Err("file is too large".into());
    }
    Ok(array.to_vec())
}

fn string_field(data: &JsValue, key: &str) -> Option<String> {
    Reflect::get(data, &JsValue::from_str(key)).ok()?.as_string()
}

fn message(kind: &str, fields: &[(&str, &JsValue)]) -> JsValue {
    let object = js_sys::Object::new();
    let kind_value = JsValue::from_str(kind);
    Reflect::set(&object, &JsValue::from_str("type"), &kind_value).ok();
    for (key, value) in fields {
        Reflect::set(&object, &JsValue::from_str(key), value).ok();
    }
    object.into()
}

fn post(api: &JsValue, value: &JsValue) -> bool {
    let Ok(post) = Reflect::get(api, &JsValue::from_str("postMessage")) else { return false };
    let Ok(post) = post.dyn_into::<js_sys::Function>() else { return false };
    post.call1(api, value).is_ok()
}

fn vscode_api() -> Option<JsValue> {
    VSCODE.with(|slot| {
        if let Some(api) = slot.borrow().as_ref() {
            return Some(api.clone());
        }
        if VSCODE_TRIED.with(std::cell::Cell::get) {
            return None;
        }
        VSCODE_TRIED.with(|tried| tried.set(true));
        let api = acquire_vscode_api()?;
        *slot.borrow_mut() = Some(api.clone());
        Some(api)
    })
}

fn acquire_vscode_api() -> Option<JsValue> {
    let window = web_sys::window()?;
    let function = Reflect::get(&window, &JsValue::from_str("acquireVsCodeApi")).ok()?;
    let function = function.dyn_into::<js_sys::Function>().ok()?;
    let api = function.call0(&JsValue::NULL).ok()?;
    if api.is_null() || api.is_undefined() { None } else { Some(api) }
}

fn random_nonce() -> Option<String> {
    let mut bytes = [0u8; 16];
    let crypto = web_sys::window()?.crypto().ok()?;
    crypto.get_random_values_with_u8_array(&mut bytes).ok()?;
    Some(host_file::hex_nonce(&bytes))
}
