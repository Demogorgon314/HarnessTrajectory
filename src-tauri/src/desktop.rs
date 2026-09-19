//! Connects the owned server process to the window, including startup timeout
//! and runtime failure reporting. No session or harness logic belongs here.
use std::{path::PathBuf, sync::Mutex, thread, time::Duration};

use tauri::Manager;

use crate::{server::ServerProcess, window};

#[derive(Default)]
pub struct Backend(Mutex<Option<ServerProcess>>);

pub fn start(app: &tauri::AppHandle) {
    if let Err(error) = launch(app) {
        window::show_failure(app, format!("Could not start the local viewer: {error}"));
    }
}

pub fn stop(app: &tauri::AppHandle) {
    if let Ok(mut backend) = app.state::<Backend>().0.lock() {
        backend.take();
    }
}

fn launch(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?.join("resources");
    let log_path = app.path().app_log_dir()?.join("server.log");
    let (process, ready) = ServerProcess::start(&runtime_path()?, &resources, &log_path)?;
    *app.state::<Backend>()
        .0
        .lock()
        .map_err(|_| "Server lock poisoned")? = Some(process);
    let handle = app.clone();
    thread::spawn(move || {
        let result = ready
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "The local viewer did not become ready.".to_string())
            .and_then(|url| window::show_viewer(&handle, url));
        if let Err(error) = result {
            stop(&handle);
            window::show_failure(
                &handle,
                format!(
                    "{error}\nQuit and reopen the app.\n\nLog: {}",
                    log_path.display()
                ),
            );
            return;
        }
        monitor(&handle, &log_path);
    });
    Ok(())
}

fn monitor(app: &tauri::AppHandle, log_path: &std::path::Path) {
    loop {
        thread::sleep(Duration::from_secs(1));
        let state = app.state::<Backend>();
        let Ok(mut backend) = state.0.lock() else {
            return;
        };
        let Some(process) = backend.as_mut() else {
            return;
        };
        if process.has_exited().unwrap_or(true) {
            backend.take();
            drop(backend);
            window::show_failure(
                app,
                format!(
                    "The local viewer stopped unexpectedly. Quit and reopen the app.\n\nLog: {}",
                    log_path.display()
                ),
            );
            return;
        }
    }
}

fn runtime_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Tauri places externalBin siblings beside the main executable, in both
    // development and the macOS bundle. Resolve independently of Finder's PATH.
    let executable = std::env::current_exe()?;
    let directory = executable.parent().ok_or("Missing executable directory")?;
    Ok(directory.join("trajectory-node"))
}
