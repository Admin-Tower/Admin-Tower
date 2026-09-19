//! Local metadata only. Private key bytes never pass through this module.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::IpAddr,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, String>;
const MAX_INVENTORY_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Authentication {
    Agent { fingerprint: String },
    KeyFile { filename: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostInput {
    pub name: String,
    pub address: String,
    pub username: String,
    pub port: u16,
    pub authentication: Authentication,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Host {
    pub id: String,
    pub settings: HostInput,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Inventory {
    version: u32,
    hosts: Vec<Host>,
}

pub fn uid() -> u32 {
    // SAFETY: geteuid has no preconditions or pointers.
    unsafe { libc::geteuid() }
}

pub fn validate_filename(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 255
        || name.starts_with('.')
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_- .".contains(&b))
        || name.trim() != name
        || name == "config"
        || name.starts_with("known_hosts")
        || name.starts_with("authorized_keys")
        || name.ends_with(".pub")
        || Path::new(name).components().count() != 1
    {
        return Err(
            "Choose a key file directly inside ~/.ssh (no symlinks or special path characters)."
                .into(),
        );
    }
    Ok(())
}

pub fn validate_host(host: &HostInput) -> Result<()> {
    let dns = host.address.len() <= 253
        && host.address.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    if !(dns || host.address.parse::<IpAddr>().is_ok()) {
        return Err("Enter a hostname, IPv4 address, or unbracketed IPv6 address.".into());
    }
    if host.name.trim().is_empty()
        || host.name.len() > 120
        || host.name.chars().any(char::is_control)
    {
        return Err("Name must contain 1–120 bytes and no control characters.".into());
    }
    if host.username.is_empty()
        || host.username.len() > 64
        || host.username.starts_with('-')
        || !host
            .username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err(
            "Enter an explicit SSH username using letters, numbers, dots, underscores or hyphens."
                .into(),
        );
    }
    if host.port == 0 {
        return Err("Port must be between 1 and 65535.".into());
    }
    match &host.authentication {
        Authentication::KeyFile { filename } => validate_filename(filename)?,
        Authentication::Agent { fingerprint } => {
            let Some(hash) = fingerprint.strip_prefix("SHA256:") else {
                return Err("Select an SSH agent identity.".into());
            };
            if hash.len() != 43
                || !hash
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/".contains(&b))
            {
                return Err("Invalid agent fingerprint.".into());
            }
        }
    }
    Ok(())
}

pub fn validate_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "Invalid host ID.".into())
}

/// Reject links in every existing component, including parents of protected files.
pub fn no_symlinks(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err("An absolute local path is required.".into());
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir | Component::CurDir) {
            return Err("Relative path components are not allowed.".into());
        }
        current.push(part);
        let meta = fs::symlink_metadata(&current)
            .map_err(|_| "A required local path is missing or inaccessible.")?;
        if meta.file_type().is_symlink() {
            return Err("Symlinks are not allowed for protected SSH or inventory paths.".into());
        }
    }
    Ok(())
}

pub fn protected_file(path: &Path, private: bool) -> Result<File> {
    no_symlinks(path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "Cannot open protected local file.")?;
    let meta = file
        .metadata()
        .map_err(|_| "Cannot inspect protected local file.")?;
    if !meta.is_file()
        || meta.uid() != uid()
        || meta.nlink() != 1
        || meta.mode() & if private { 0o077 } else { 0o022 } != 0
    {
        return Err("Local file has unsafe ownership, permissions, type, or hard links.".into());
    }
    Ok(file)
}

pub fn private_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        let parent = path.parent().ok_or("Invalid inventory directory.")?;
        if !parent.exists() {
            private_dir(parent)?;
        }
        no_symlinks(parent)?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|_| "Cannot create private application directory.")?;
    }
    no_symlinks(path)?;
    let meta = fs::metadata(path).map_err(|_| "Cannot inspect application directory.")?;
    if !meta.is_dir() || meta.uid() != uid() || meta.mode() & 0o077 != 0 {
        return Err("Application directory must be owned by you with mode 0700.".into());
    }
    Ok(())
}

pub struct Store {
    pub directory: PathBuf,
}

struct StoreLock(File);

impl Drop for StoreLock {
    fn drop(&mut self) {
        // Explicit unlock also releases locks briefly inherited by a concurrent fork.
        // SAFETY: this descriptor remains owned and open until after Drop returns.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

impl Store {
    fn lock(&self) -> Result<StoreLock> {
        private_dir(&self.directory)?;
        let path = self.directory.join("inventory.lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
            .map_err(|_| "Cannot open inventory lock.")?;
        protected_file(&path, true)?;
        // SAFETY: flock operates on this live owned descriptor; dropping it releases the lock.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("Inventory is busy in another window. Please retry.".into());
        }
        Ok(StoreLock(file))
    }

    fn read(&self) -> Result<Inventory> {
        let path = self.directory.join("hosts.json");
        if matches!(fs::symlink_metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(Inventory {
                version: 1,
                hosts: vec![],
            });
        }
        let mut bytes = Vec::new();
        protected_file(&path, true)?
            .take(MAX_INVENTORY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read inventory; existing file was preserved.")?;
        if bytes.len() as u64 > MAX_INVENTORY_BYTES {
            return Err("Inventory exceeds the size limit; file preserved.".into());
        }
        let inventory: Inventory = serde_json::from_slice(&bytes)
            .map_err(|_| "Inventory is malformed; existing file was preserved. Restore a valid backup of hosts.json.")?;
        if inventory.version != 1 {
            return Err("Unsupported inventory version; existing file preserved.".into());
        }
        let mut ids = HashSet::new();
        for host in &inventory.hosts {
            validate_id(&host.id)?;
            validate_host(&host.settings)?;
            if !ids.insert(&host.id) {
                return Err("Duplicate host IDs in inventory; existing file preserved.".into());
            }
        }
        Ok(inventory)
    }

    fn write(&self, inventory: &Inventory) -> Result<()> {
        let bytes =
            serde_json::to_vec_pretty(inventory).map_err(|_| "Cannot serialize inventory.")?;
        if bytes.len() as u64 > MAX_INVENTORY_BYTES {
            return Err("Inventory size limit reached.".into());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|_| "Cannot create inventory update.")?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "Cannot write inventory update.")?;
        temporary
            .persist(self.directory.join("hosts.json"))
            .map_err(|_| "Cannot replace inventory atomically.")?;
        File::open(&self.directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| "Cannot sync inventory directory.")?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Host>> {
        let _lock = self.lock()?;
        Ok(self.read()?.hosts)
    }

    pub fn save(&self, id: Option<String>, settings: HostInput) -> Result<Host> {
        validate_host(&settings)?;
        let _lock = self.lock()?;
        let mut inventory = self.read()?;
        let host = if let Some(id) = id {
            validate_id(&id)?;
            let existing = inventory
                .hosts
                .iter_mut()
                .find(|h| h.id == id)
                .ok_or("Host no longer exists. Refresh the inventory.")?;
            existing.settings = settings;
            existing.clone()
        } else {
            let host = Host {
                id: uuid::Uuid::new_v4().to_string(),
                settings,
            };
            inventory.hosts.push(host.clone());
            host
        };
        self.write(&inventory)?;
        Ok(host)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let _lock = self.lock()?;
        let mut inventory = self.read()?;
        let before = inventory.hosts.len();
        inventory.hosts.retain(|h| h.id != id);
        if before == inventory.hosts.len() {
            return Err("Host no longer exists.".into());
        }
        self.write(&inventory)
    }

    pub fn get(&self, id: &str) -> Result<Host> {
        validate_id(id)?;
        self.list()?
            .into_iter()
            .find(|h| h.id == id)
            .ok_or("Host no longer exists.".into())
    }
}
