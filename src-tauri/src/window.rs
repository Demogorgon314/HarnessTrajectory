//! Window presentation and navigation policy. The renderer receives no native
//! capabilities: all session operations still use the existing HTTP API.
use std::{process::Command, sync::Mutex, thread};

use tauri::{Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Default)]
pub struct ViewerState {
    origin: Mutex<Option<String>>,
    failure: Mutex<Option<String>>,
}

pub fn create(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle().clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Harness Trajectory")
        // The sidebar already displays the brand; retain the title for window menus.
        .hidden_title(true)
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(move |url| {
            let state = handle.state::<ViewerState>();
            let Ok(origin) = state.origin.lock() else {
                return false;
            };
            if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
                return origin.is_none();
            }
            if origin.as_ref() == Some(&url.origin().ascii_serialization()) {
                return true;
            }
            open_external(url);
            false
        })
        .on_new_window(|url, _| {
            open_external(&url);
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(|window, _| {
            // A launch failure can precede the bootstrap document's first load.
            let state = window.state::<ViewerState>();
            if let Ok(failure) = state.failure.lock() {
                if let Some(message) = failure.as_ref() {
                    render_failure(&window, message);
                }
            };
        })
        .build()?;
    Ok(())
}

pub fn show_viewer(app: &tauri::AppHandle, url: Url) -> Result<(), String> {
    let state = app.state::<ViewerState>();
    *state
        .origin
        .lock()
        .map_err(|_| "Window state lock poisoned")? = Some(url.origin().ascii_serialization());
    if let Some(window) = app.get_webview_window("main") {
        window.navigate(url).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn show_failure(app: &tauri::AppHandle, message: String) {
    if let Ok(mut failure) = app.state::<ViewerState>().failure.lock() {
        *failure = Some(message.clone());
    }
    if let Some(window) = app.get_webview_window("main") {
        render_failure(&window, &message);
    }
}

fn render_failure(window: &WebviewWindow, message: &str) {
    // JSON encoding keeps paths/error text out of executable JavaScript.
    let text = serde_json::json!(message).to_string();
    let _ = window.eval(format!(
        "(() => {{ document.body.replaceChildren(); const p = document.createElement('p'); p.style.cssText = 'padding:48px;white-space:pre-wrap;font:16px system-ui'; p.textContent = {text}; document.body.append(p); }})();"
    ));
}

fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let url = url.to_string();
        thread::spawn(move || {
            let _ = Command::new("/usr/bin/open").arg(url).status();
        });
    }
}
