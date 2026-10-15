//! A file handed to the web app by an embedding host (the VS Code / code-server extension).
//!
//! The editor itself stays the WebAssembly build. The extension only delivers the opened
//! workspace file and writes back what the app saves. These checks run before any bytes are
//! kept: a message cannot rename itself into another directory, fetch an arbitrary URL, or
//! allocate past the cap the extension agrees to (`packaging/vscode/host.js`).

/// Largest file the host bridge will accept. Matches `MAX_HOST_FILE_BYTES` in
/// `packaging/vscode/host.js` (1 GiB). Larger reads are refused before they are queued.
pub const MAX_HOST_FILE_BYTES: usize = 1024 * 1024 * 1024;

/// The file name to open and, on save, to write. Directory components are dropped so a
/// message cannot escape the opened file's folder. Empty names, `.` and `..` are refused.
pub fn host_file_name(name: &str) -> Result<String, &'static str> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let base = base.trim();
    if base.is_empty() || base == "." || base == ".." || base.contains('\0') || base.len() > 255 {
        return Err("missing file name");
    }
    Ok(base.to_string())
}

/// `true` when `got` is the nonce this page generated. Anything else is ignored, so a
/// message that did not come back from the extension host cannot open or save a file.
pub fn same_nonce(expected: &str, got: &str) -> bool {
    expected.len() == 32 && expected.as_bytes().iter().all(u8::is_ascii_hexdigit) && expected == got
}

/// Encode 16 random bytes as the nonce the extension must echo.
pub fn hex_nonce(bytes: &[u8; 16]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(32);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

/// URLs the page is willing to fetch for the extension. `https` covers VS Code's webview
/// resource host (its exact domain differs by product and version). Loopback `http` covers
/// code-server on a local address. `file:` and other schemes are refused.
pub fn allowed_host_url(url: &str) -> bool {
    if url.len() > 4096 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(url, "vscode-webview-resource:") {
        return !rest.is_empty();
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(url, "vscode-resource:") {
        return !rest.is_empty();
    }
    let Some(scheme_end) = url.find("://") else { return false };
    let scheme = &url[..scheme_end];
    let rest = &url[scheme_end + 3..];
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    if scheme.eq_ignore_ascii_case("https") {
        return true;
    }
    scheme.eq_ignore_ascii_case("http") && loopback_host(authority)
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    if value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix) { Some(&value[prefix.len()..]) } else { None }
}

fn loopback_host(authority: &str) -> bool {
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split_once(']').map(|(host, _)| host).unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_drop_directories_and_refuse_empties() {
        assert_eq!(host_file_name("dir/photo.psd").as_deref(), Ok("photo.psd"));
        assert_eq!(host_file_name(r"C:\pics\photo.PSD").as_deref(), Ok("photo.PSD"));
        assert_eq!(host_file_name("  leaf.png  ").as_deref(), Ok("leaf.png"));
        assert!(host_file_name("").is_err());
        assert!(host_file_name("   ").is_err());
        assert!(host_file_name(".").is_err());
        assert!(host_file_name("..").is_err());
        assert!(host_file_name("dir/..").is_err());
        assert!(host_file_name("a\0b.png").is_err());
        assert!(host_file_name(&"n".repeat(256)).is_err());
    }

    #[test]
    fn nonces_must_be_the_page_nonce() {
        let nonce = hex_nonce(&[0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f, 0x60, 0x71, 0x82, 0x93, 0xa4, 0xb5, 0xc6, 0xd7, 0xe8, 0xf9]);
        assert_eq!(nonce, "0a1b2c3d4e5f60718293a4b5c6d7e8f9");
        assert!(same_nonce(&nonce, &nonce));
        assert!(!same_nonce(&nonce, "0a1b2c3d4e5f60718293a4b5c6d7e8f8"));
        assert!(!same_nonce(&nonce, ""));
        assert!(!same_nonce("short", "short"));
        assert!(!same_nonce(&"g".repeat(32), &"g".repeat(32)));
    }

    #[test]
    fn host_urls_are_webview_resources_or_loopback() {
        assert!(allowed_host_url("https://file+.vscode-resource.vscode-cdn.net/media/a.psd"));
        assert!(allowed_host_url("http://127.0.0.1:8080/vscode-resource?path=%2Fa.psd"));
        assert!(allowed_host_url("http://localhost:8080/a.png"));
        assert!(allowed_host_url("http://[::1]:8080/a.png"));
        assert!(allowed_host_url("vscode-webview-resource://authority/media/a.wasm"));
        assert!(allowed_host_url("vscode-resource:/media/a.wasm"));
        assert!(!allowed_host_url("file:///etc/passwd"));
        assert!(!allowed_host_url("javascript:alert(1)"));
        assert!(!allowed_host_url("data:text/html,hi"));
        assert!(!allowed_host_url("http://evil.com/a.psd"));
        assert!(!allowed_host_url("http://127.0.0.1.evil.com/a.psd"));
        assert!(!allowed_host_url("http://user:pass@127.0.0.1/a.psd"));
        assert!(!allowed_host_url("https://user@cdn.example/a.psd"));
        assert!(!allowed_host_url("https://cdn.example/a.psd\n"));
        assert!(!allowed_host_url(""));
        assert!(!allowed_host_url("vscode-webview-resource:"));
    }

    /// The extension manifest must open PSD and the other image formats, and must agree with
    /// the host shim on the editor id and the size cap. VS Code reads `package.json`; the page
    /// reads nothing from it, so this is the check that the two stay wired together.
    #[test]
    fn vscode_extension_opens_psd_and_images() {
        let pkg = include_str!("../../../packaging/vscode/package.json");
        let extension = include_str!("../../../packaging/vscode/extension.js");
        let shim = include_str!("../../../packaging/vscode/host.js");
        let view = "ai.storyteller.photocraft.editor";
        assert!(pkg.contains(view), "custom editor id");
        assert!(shim.contains(view), "host shim id");
        assert!(extension.contains("registerCustomEditorProvider"), "editor provider");
        assert!(extension.contains("require(\"./host\")") || extension.contains("require('./host')"), "shim import");
        assert!(shim.contains("1024 * 1024 * 1024"), "size cap shared with the page");
        assert_eq!(MAX_HOST_FILE_BYTES, 1024 * 1024 * 1024);
        for ext in ["psd", "psb", "psdt", "pcraft", "png", "jpg", "jpeg", "tif", "tiff", "webp", "gif", "bmp", "svg"] {
            assert!(pkg.contains(&format!("*.{ext}")), "{ext} is not a custom-editor pattern");
        }
    }
}
