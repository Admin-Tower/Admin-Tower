//! Shared bounded Ansible module execution with live output.
use crate::{
    automation,
    inventory::{self, Result},
};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
    thread,
    time::{Duration, Instant},
};

pub(crate) fn invoke(
    root: &Path,
    variables: Value,
    module: &str,
    args: Value,
    limit: Duration,
    logs: &mut dyn FnMut(String),
) -> Result<Value> {
    fs::write(
        root.join("inventory.json"),
        serde_json::to_vec(&json!({"all":{"hosts":{"target":variables}}})).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let tree = root.join(uuid::Uuid::new_v4().to_string());
    inventory::private_dir(&tree)?;
    let output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut command = automation::context(root)?;
    let mut process = automation::Process(
        command
            .args([
                "target",
                "-i",
                "inventory.json",
                "-m",
                module,
                "-a",
                &args.to_string(),
                "-vvv",
                "-T",
                "15",
                "--tree",
            ])
            .arg(&tree)
            .stdout(output.try_clone().map_err(|e| e.to_string())?)
            .stderr(output.try_clone().map_err(|e| e.to_string())?)
            .spawn()
            .map_err(|_| {
                "Cannot run /usr/bin/ansible. Install ansible-core outside Admin-Tower."
            })?,
    );
    let started = Instant::now();
    let status = loop {
        if output.metadata().map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024 {
            return Err(
                "Ansible output exceeded the limit. Refresh the host before retrying.".into(),
            );
        }
        logs(automation::log_tail(&output)?);
        if let Some(status) = process.0.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > limit {
            return Err(
                "Ansible monitoring timed out. Refresh the host before considering another action."
                    .into(),
            );
        }
        thread::sleep(Duration::from_millis(150));
    };
    drop(process);
    logs(automation::log_tail(&output)?);
    let mut bytes = Vec::new();
    File::open(tree.join("target"))
        .map_err(|_| "Ansible did not return a result. Refresh the host if dispatch was started.")?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("Oversized Ansible result.".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Ansible result.")?;
    if !status.success()
        || value["failed"] == true
        || value["unreachable"] == true
        || value["rc"].as_i64().is_some_and(|rc| rc != 0)
    {
        return Err(value["msg"]
            .as_str()
            .or(value["stdout"].as_str())
            .unwrap_or("Ansible operation could not be verified. Refresh the host.")
            .chars()
            .take(8000)
            .collect());
    }
    Ok(value)
}
