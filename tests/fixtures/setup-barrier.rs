//! Native setup transport fixture: exposes a barrier before forwarding real setup.
use std::os::windows::process::CommandExt;
use std::{
    fs,
    io::{self, BufRead, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
fn main() {
    let root = std::env::var_os("RUNSEAL_PREPARATION_BARRIER").unwrap();
    let root = std::path::PathBuf::from(root);
    let real = std::env::var_os("RUNSEAL_PREPARATION_HELPER").unwrap();
    for (index, line) in io::stdin().lock().lines().enumerate() {
        let line = line.unwrap();
        // The production frame is a JSON Windows path. Decode the escaping
        // emitted by serde_json without introducing a fixture dependency.
        let mut path = String::new();
        let mut chars = line.trim().trim_matches('"').chars();
        while let Some(c) = chars.next() {
            path.push(if c == '\\' { chars.next().unwrap() } else { c });
        }
        if index == 0 {
            fs::write(
                root.join("preparation-entered"),
                std::process::id().to_string(),
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(20);
            while !root.join("release-preparation").exists() {
                assert!(Instant::now() < deadline, "preparation barrier expired");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let status = Command::new(&real)
            .args(["--payload-file", &path])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        println!("{}", if status.success() { 0 } else { 1 });
        io::stdout().flush().unwrap();
    }
}
