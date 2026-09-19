//! A bounded, read-only htop terminal. No arbitrary commands or credential prompts.
use crate::{
    inventory::{Host, Result, Store},
    ssh::{self, Environment, Prepared},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::process::CommandExt,
    },
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_OUTPUT: usize = 512 * 1024;
const REMOTE: &str = "if [ ! -x /usr/bin/htop ]; then printf 'htop is not installed at /usr/bin/htop. Install it outside Admin-Tower.\n'; exit 127; fi; exec /usr/bin/env TERM=xterm-256color HTOPRC=/dev/null /usr/bin/htop --readonly --delay=10";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub data: String,
    pub ended: bool,
    pub message: String,
}
struct Buffer {
    bytes: Vec<u8>,
    ended: bool,
    message: String,
    heartbeat: Instant,
}
enum Input {
    Bytes(Vec<u8>),
    Size(u16, u16),
}
struct Session {
    host_id: String,
    buffer: Arc<Mutex<Buffer>>,
    input: SyncSender<Input>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Session>>);
impl Sessions {
    pub fn start(
        &self,
        store: &Store,
        environment: &Environment,
        id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        dimensions(cols, rows)?;
        let host = store.get(id)?;
        let prepared = ssh::prepare(&host, environment, &store.directory)?;
        let mut sessions = self.0.lock().map_err(|_| "Live sessions unavailable.")?;
        sessions.retain(|_, s| !s.buffer.lock().map(|b| b.ended).unwrap_or(true));
        if sessions.len() >= 3 || sessions.values().any(|s| s.host_id == id) {
            return Err("A live session is already open for this host, or the three-session limit was reached.".into());
        }
        let (tx, rx) = mpsc::sync_channel(64);
        let buffer = Arc::new(Mutex::new(Buffer {
            bytes: vec![],
            ended: false,
            message: "Opening htop session…".into(),
            heartbeat: Instant::now(),
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let output = buffer.clone();
        let cancelled = stop.clone();
        let worker = thread::spawn(move || {
            let result = run(host, prepared, cols, rows, rx, &output, &cancelled);
            if let Ok(mut state) = output.lock() {
                state.ended = true;
                state.message = result.err().unwrap_or_else(|| "htop session ended.".into());
            }
        });
        let session_id = uuid::Uuid::new_v4().to_string();
        sessions.insert(
            session_id.clone(),
            Session {
                host_id: id.into(),
                buffer,
                input: tx,
                stop,
                worker: Some(worker),
            },
        );
        Ok(session_id)
    }
    pub fn poll(&self, id: &str) -> Result<Frame> {
        let sessions = self.0.lock().map_err(|_| "Live sessions unavailable.")?;
        let session = sessions.get(id).ok_or("Live session has ended.")?;
        let mut buffer = session
            .buffer
            .lock()
            .map_err(|_| "Live output unavailable.")?;
        buffer.heartbeat = Instant::now();
        let frame = Frame {
            data: STANDARD.encode(&buffer.bytes),
            ended: buffer.ended,
            message: buffer.message.clone(),
        };
        buffer.bytes.clear();
        Ok(frame)
    }
    pub fn input(&self, id: &str, data: String) -> Result<()> {
        if data.is_empty() || data.len() > 1024 {
            return Err("Terminal input exceeds the limit.".into());
        }
        self.send(id, Input::Bytes(data.into_bytes()))
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        dimensions(cols, rows)?;
        self.send(id, Input::Size(cols, rows))
    }
    fn send(&self, id: &str, input: Input) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| "Live sessions unavailable.")?
            .get(id)
            .ok_or("Live session has ended.")?
            .input
            .try_send(input)
            .map_err(|_| "Terminal is busy or closed. Retry the key or reconnect.".into())
    }
    pub fn stop(&self, id: &str) -> Result<()> {
        let session = self
            .0
            .lock()
            .map_err(|_| "Live sessions unavailable.")?
            .remove(id);
        drop(session);
        Ok(())
    }
    pub fn stop_all(&self) {
        if let Ok(mut sessions) = self.0.lock() {
            sessions.clear();
        }
    }
}
fn dimensions(cols: u16, rows: u16) -> Result<()> {
    if !(20..=400).contains(&cols) || !(8..=150).contains(&rows) {
        return Err("Unsupported terminal dimensions.".into());
    }
    Ok(())
}
fn resize(fd: i32, cols: u16, rows: u16) -> std::io::Result<()> {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: fd is an owned PTY descriptor and size is a valid winsize.
    if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
fn pty(cols: u16, rows: u16) -> Result<(File, File)> {
    let mut master = -1;
    let mut slave = -1;
    // SAFETY: pointers to descriptor outputs are valid; optional arguments are null.
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    } != 0
    {
        return Err("Cannot allocate htop terminal.".into());
    }
    // SAFETY: openpty succeeded; each owned descriptor is transferred exactly once.
    let (master, slave) = unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) };
    let mut settings = std::mem::MaybeUninit::uninit();
    // SAFETY: descriptors are owned; termios is initialized only on successful tcgetattr.
    unsafe {
        if libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) == -1
            || libc::fcntl(slave.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) == -1
            || libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) == -1
            || libc::tcgetattr(slave.as_raw_fd(), settings.as_mut_ptr()) != 0
        {
            return Err("Cannot configure htop terminal.".into());
        }
        let mut settings = settings.assume_init();
        libc::cfmakeraw(&mut settings);
        if libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &settings) != 0 {
            return Err("Cannot configure htop terminal.".into());
        }
    }
    resize(master.as_raw_fd(), cols, rows).map_err(|_| "Cannot size htop terminal.")?;
    Ok((master, slave))
}
fn command(prepared: &Prepared) -> Command {
    let mut command = Command::new("/usr/bin/ssh");
    command
        .args(["-tt", "-o", "BatchMode=yes"])
        .args(&prepared.arguments)
        .arg(REMOTE)
        .env("TERM", "xterm-256color")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env_remove("SSH_ASKPASS")
        .env_remove("SSH_SK_PROVIDER")
        .env_remove("LD_PRELOAD")
        .env_remove("LD_LIBRARY_PATH");
    command
}
fn run(
    _host: Host,
    prepared: Prepared,
    cols: u16,
    rows: u16,
    input: mpsc::Receiver<Input>,
    output: &Arc<Mutex<Buffer>>,
    stop: &AtomicBool,
) -> Result<()> {
    let (mut master, slave) = pty(cols, rows)?;
    let mut command = command(&prepared);
    command
        .stdin(Stdio::from(
            slave
                .try_clone()
                .map_err(|_| "Cannot open terminal input.")?,
        ))
        .stdout(Stdio::from(
            slave
                .try_clone()
                .map_err(|_| "Cannot open terminal output.")?,
        ))
        .stderr(Stdio::from(slave));
    // The worker that spawns SSH lives until SSH is reaped. Linux also kills SSH if
    // this worker/app dies unexpectedly, preventing an orphaned remote htop session.
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: only async-signal-safe libc calls are made between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
                || libc::getppid() != parent
                || libc::setsid() == -1
                || libc::ioctl(0, libc::TIOCSCTTY, 0) == -1
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start system SSH for htop.")?;
    let began = Instant::now();
    let mut pending = Vec::new();
    let result = (|| -> Result<()> {
        loop {
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            if began.elapsed() > Duration::from_secs(3600) {
                return Err("One-hour session limit reached. Start a new session.".into());
            }
            if output
                .lock()
                .map_err(|_| "Live output unavailable.")?
                .heartbeat
                .elapsed()
                > Duration::from_secs(20)
            {
                return Err("Live view disconnected; session stopped.".into());
            }
            for event in input.try_iter().take(32) {
                match event {
                    Input::Bytes(bytes) => {
                        if pending.len() + bytes.len() > 65536 {
                            return Err("Terminal input limit reached.".into());
                        }
                        pending.extend(bytes);
                    }
                    Input::Size(cols, rows) => resize(master.as_raw_fd(), cols, rows)
                        .map_err(|_| "Cannot resize terminal.")?,
                }
            }
            if !pending.is_empty() {
                match master.write(&pending) {
                    Ok(count) => {
                        pending.drain(..count);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => return Err("Terminal input closed.".into()),
                }
            }
            let mut chunk = [0u8; 16384];
            // Bound reads each pass so floods cannot starve cancellation or child reaping.
            for _ in 0..16 {
                match master.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        let mut state = output.lock().map_err(|_| "Live output unavailable.")?;
                        if state.bytes.len() + count > MAX_OUTPUT {
                            return Err(
                                "Terminal output exceeded its buffer limit. Session stopped."
                                    .into(),
                            );
                        }
                        state.bytes.extend_from_slice(&chunk[..count]);
                        state.message = "Session active · read-only htop".into();
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            || error.raw_os_error() == Some(libc::EIO) =>
                    {
                        break
                    }
                    Err(_) => return Err("Terminal output closed.".into()),
                }
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "Cannot inspect live SSH session.")?
            {
                if status.success() {
                    return Ok(());
                }
                return Err("htop or SSH exited with an error. Check the terminal output. An unlocked agent identity and remote htop with --readonly support are required.".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    drop(prepared);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_terminal_dimensions() {
        assert!(dimensions(80, 24).is_ok());
        assert!(dimensions(0, 24).is_err());
        assert!(dimensions(401, 24).is_err());
        assert!(dimensions(80, 151).is_err());
    }
    #[test]
    fn terminal_is_raw_and_resizable() {
        let (master, slave) = pty(80, 24).unwrap();
        resize(master.as_raw_fd(), 120, 40).unwrap();
        let mut size = std::mem::MaybeUninit::<libc::winsize>::uninit();
        // SAFETY: valid terminal descriptor and writable winsize output.
        assert_eq!(
            unsafe { libc::ioctl(slave.as_raw_fd(), libc::TIOCGWINSZ, size.as_mut_ptr()) },
            0
        );
        let size = unsafe { size.assume_init() };
        assert_eq!((size.ws_col, size.ws_row), (120, 40));
    }
    #[test]
    fn fixed_remote_command_never_falls_back_to_shell_or_sudo() {
        assert!(REMOTE.contains("exec /usr/bin/env"));
        assert!(REMOTE.contains("--readonly"));
        assert!(REMOTE.contains("HTOPRC=/dev/null"));
        assert!(!REMOTE.contains("sudo"));
        assert!(!REMOTE.contains("|| /bin/sh"));
        let sessions = Sessions::default();
        assert!(sessions.input("missing", "x".repeat(1025)).is_err());
        assert!(sessions.poll("missing").is_err());
        assert!(sessions.stop("missing").is_ok());
    }
}
