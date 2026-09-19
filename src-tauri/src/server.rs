//! Owns the Node child. HTTP readiness travels over stdout; stdin lifetime is
//! the shutdown signal, including when the desktop parent is forcibly killed.
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use tauri::Url;

const READY_PREFIX: &str = "HARNESS_TRAJECTORY_READY ";

#[derive(Deserialize)]
struct ReadyMessage {
    url: String,
}

/// A child is either owned here or already reaped. No detached service survives
/// a failed startup, a window construction error, or normal application exit.
pub struct ServerProcess {
    child: Child,
}

impl ServerProcess {
    pub fn start(
        runtime: &Path,
        resources: &Path,
        log_path: &Path,
    ) -> io::Result<(Self, Receiver<Url>)> {
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut log = File::create(log_path)?;
        let child = Command::new(runtime)
            .arg(resources.join("server/main.js"))
            .args(["--desktop", "--no-open", "--static"])
            .arg(resources.join("server/public"))
            .current_dir(resources)
            // User-configured harness roots and cache overrides still apply.
            // Node injection and a stale static override must not alter the bundle.
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env_remove("HARNESS_TRAJECTORY_STATIC")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log.try_clone()?))
            .spawn()?;
        let mut process = Self { child };
        let stdout = process
            .child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Missing server stdout pipe"))?;
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(url) = ready_url(&line) {
                    // The launch URL contains a secret; it must never enter logs.
                    let _ = sender.send(url);
                } else {
                    let _ = writeln!(log, "{line}");
                }
            }
        });
        Ok((process, receiver))
    }

    pub fn has_exited(&mut self) -> io::Result<bool> {
        Ok(self.child.try_wait()?.is_some())
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        // Closing the pipe lets Node flush caches through its ordinary shutdown.
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Err(_) => break,
                Ok(None) => thread::sleep(Duration::from_millis(25)),
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn ready_url(line: &str) -> Option<Url> {
    let message: ReadyMessage = serde_json::from_str(line.strip_prefix(READY_PREFIX)?).ok()?;
    let url = Url::parse(&message.url).ok()?;
    // Never navigate a privileged desktop window to an arbitrary stdout URL.
    (url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_requires_a_structured_loopback_url() {
        assert!(ready_url("ordinary server log").is_none());
        assert!(ready_url("HARNESS_TRAJECTORY_READY {broken").is_none());
        for url in [
            "https://example.com",
            "http://localhost:1234",
            "file:///tmp/a",
            "http://127.0.0.1",
            "http://user@127.0.0.1:1234",
        ] {
            let line = format!("{READY_PREFIX}{}", serde_json::json!({ "url": url }));
            assert!(ready_url(&line).is_none(), "accepted {url}");
        }
        let line = format!(
            "{READY_PREFIX}{}",
            serde_json::json!({ "url": "http://127.0.0.1:1234/?desktop_token=secret" })
        );
        assert_eq!(ready_url(&line).map(|url| url.port()), Some(Some(1234)));
    }
}
