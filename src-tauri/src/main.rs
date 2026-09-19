mod desktop;
mod server;
mod window;

use tauri::{Manager, RunEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(desktop::Backend::default())
        .manage(window::ViewerState::default())
        .setup(|app| {
            window::create(app)?;
            desktop::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize Harness Trajectory")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                desktop::stop(app);
            }
        });
}
