# Admin-Tower
Control Tower for System Administration.

## UI styling

The `tower-ui` Angular app uses Angular Material and Tailwind CSS.

- Import Material components from `@angular/material/<component>` into standalone
  components as needed. Customize the Material theme in
  `apps/web/tower-ui/src/styles.scss`.
- Use Tailwind utility classes directly in templates. Tailwind is processed by
  PostCSS through `apps/web/tower-ui/src/tailwind.css`, separately from SCSS.
  Source detection is scoped to the app's `src` directory; add `@source` paths in
  that file when introducing shared UI libraries.

Run `pnpm nx serve tower-ui` for development or `pnpm nx build tower-ui` for a
production build.

## SSH host inventory (Linux desktop)

Run `pnpm nx serve tower-desktop`, then open **Hosts**. Add a name, hostname or
unbracketed IP address, explicit SSH username, port, and an SSH identity. Hosts
can be searched, edited, and removed. **Open terminal** starts system OpenSSH in
GNOME Terminal, Konsole, or xterm; select another installed terminal in the list
if needed. Install `openssh-client` and one of these terminals before connecting.
The browser build explains that local inventory requires the desktop app.

Two authentication modes are available:

- **SSH agent identity:** select a loaded identity by its SHA-256 public-key
  fingerprint. Start the app from your normal desktop session with `SSH_AUTH_SOCK`
  available. Only that identity is offered; the app never loads keys into the agent.
- **Key file in ~/.ssh:** choose a file directly inside your account's `.ssh`
  directory. Only OpenSSH reads the private key and prompts for its passphrase,
  inside the terminal. This mode does not fall back to agent authentication.

The account home is resolved from the current Linux user, not from a supplied
path. Run the app without sudo. The home must not be writable by others; `.ssh`
must have mode `0700`. Key files must be owned by you, have no group/other access
(normally `0600`), and be regular files with no symbolic or hard links. Directory
symlinks and path expansion characters are rejected. File selection checks only
metadata; OpenSSH determines whether a candidate is a usable private key. The app
does not change permissions, import keys, or collect passphrases.

### Server trust

Connections require a matching, independently verified key in your existing
`~/.ssh/known_hosts`. Obtain the server fingerprint through a trusted channel,
such as the provider console or the server administrator, and establish trust
outside Admin-Tower before connecting. Non-default ports use `[hostname]:port`
entries; hashed entries work too. The file must be owned by you and not writable
by other users. Unknown, revoked, or changed keys fail closed. Investigate key
changes independently; do not simply remove a warning or trust `ssh-keyscan`
output without verifying its fingerprint.

Inventory connections ignore both user and system SSH configuration. Password
authentication, automatic host-key updates, forwarding, proxy commands, local
commands, escape commands, and connection sharing are disabled. Jump hosts and
SSH-config aliases are not supported in this version. Cryptographic algorithm
selection remains with system OpenSSH. See the [OpenSSH options reference](https://man.openbsd.org/ssh_config).

### Local storage and security boundary

Host metadata is stored in `hosts.json` under Tauri's user application-data
directory (normally `~/.local/share/io.github.admintower.desktop/`). The directory
is `0700`, the inventory is `0600`, updates are atomic, and a file lock prevents
overlapping writes across processes. Malformed or unsupported inventory is
preserved and reported; restore a valid backup rather than deleting it blindly.
Deleting a host never deletes keys or changes server trust. Agent connections
temporarily write only the selected **public** key to this private directory;
normal session completion removes it.

The webview has no general filesystem or shell permission. Only the local main
window can call the inventory commands, and Rust validates each request. A
terminal helper revalidates the saved host and identity immediately before SSH
starts, and keeps session output out of the app's logs. “Terminal launched” is
not an authentication result; inspect the terminal for connection success or
failure. Terminal sessions continue independently if the app closes.

These controls protect the app's credential boundary, not a compromised Linux
account or modified system executables. Keep the desktop account, agent, terminal,
and OpenSSH installation trusted. See [Tauri capabilities](https://v2.tauri.app/security/capabilities/).

## Automation catalog (Linux desktop)

The sidenav separates **Hosts**, **Groups**, and **Automation**. Select individual
rows in Hosts and group cards in Groups; these independent choices stay in the
application session while navigating. Deselecting a group does not discard an
individually selected host or another selected group. Shared members run once.
Hosts included through selected groups are identified on their inventory rows.

In **Automation**, click the **Ping** card to immediately start the task on the
session selection and open its results. The **▶ Run Ping** button on Hosts and
Groups provides the same one-click action. **Results & details** opens the task
without starting anything. There is no separate target picker or second Run
step after choosing the card. The catalog shows the selected host/group counts
and total unique hosts.

Selections are consumed only after the backend accepts the run. Missing Ansible,
stale targets, and an already active run leave the selection intact for retry.
Choices added while a start is pending remain available for the next run. The
active run keeps its original snapshot, independently of later navigation,
selection changes, group edits, or cancellation. Results remain available for
the application session. Selections and results are not persistent run history.

Groups owns the group cards, overlap summaries, creation, editing and deletion.
**New group** opens a focused membership editor using the existing Hosts rows;
**Save as group** on Hosts starts that editor from the selected host rows.
Membership editing uses a separate draft and never replaces the session's
automation selection. Group cards link to member hosts and intersections with
other groups. Host search and these filters do not change execution targets.

Deleting a group preserves its hosts and removes that group's explicit selection;
deleting a host removes its memberships and explicit selection. Inventory format
2 stores group IDs, names and member host IDs. Version 1 inventories load without
groups and migrate atomically on the next successful write.

The desktop runs `/usr/bin/ansible` locally (validated with ansible-core 2.20.1).
It does not install dependencies. Targets need SSH public-key authentication and
Python supported by your installed ansible-core. This uses
[`ansible.builtin.ping`](https://docs.ansible.com/projects/ansible/latest/collections/ansible/builtin/ping_module.html):
SSH login and Python execution must return `pong`. It is **not ICMP/network ping**.

Ansible reuses each host's selected key reference or individual agent identity,
custom port and strict host-key checks. Authentication is noninteractive: load
an unlocked key into an agent outside Admin-Tower and select that identity if
your key requires a passphrase. Establish verified server trust outside the app.
A preparation failure affects only that host; valid members continue.

Quick Ping on a host row runs independently of other hosts and bulk Ping. Only
that host's button is disabled while its check runs; results update in place and
preserve other hosts' statuses. Renaming the inventory entry or remote hostname
does not invalidate Ping; only changes to the SSH address, port, username or selected
identity require a new check. Quick jobs remain active across navigation and
are cancelled when the desktop shuts down.

Inventory hostname/OS/kernel information uses a dedicated, read-only SSH query instead of
full host inspection. Last known values remain visible during refresh and transient
failures (the tooltip identifies retained data), and survive navigation within the
session. Queries are deduplicated by saved connection and run up to four at a time.
While the inventory is visible, failed queries retry every 15 seconds and known
metadata refreshes after 60 seconds. Successful Ping and reboot results trigger
an OS refresh too. Changed connection settings invalidate cached metadata.

Use the pencil beside **Hostname** on an inventory row to edit the remote system
hostname. **Save hostname** runs `ansible.builtin.hostname` and verifies the result
through Ansible before updating the displayed value. This currently supports Ubuntu,
requires root or passwordless sudo, and shows progress plus expandable live logs
without leaving the inventory. DNS, `/etc/hosts`, cloud-init configuration, the saved
inventory name and SSH destination remain separate. Cloud provisioning may override
the hostname on a later boot. Failed or unconfirmed changes are never retried
automatically; refresh the host before submitting another change.

On desktop startup, Admin-Tower automatically runs Ping once against all saved hosts.
The check runs in the background without changing your selection or opening another
page. Empty inventories are skipped; navigation does not trigger another check.

Only one run may be active. The backend resolves all selected IDs in one locked
inventory read, rejects missing hosts or groups, deduplicates by host ID, and
snapshots membership and host
settings at start, so subsequent edits do not retarget it. The Ping task page
shows progress, elapsed time, cancellation, per-host outcomes and expandable
diagnostics. Missing or malformed results are failures. The latest run lives in
backend memory across navigation and is discarded when the app exits; no run
history is persisted. Hosts also shows a compact Ping indicator on each row,
updated once per second while the latest run is active. Expand it for diagnostics
or open the full run. These are results of the latest SSH/Python check, not live
network availability: hosts outside that run show Not checked, and edited host
settings invalidate the displayed result. Cancel and normal app exit kill the local process group.

Execution uses a private temporary inventory with internal aliases, five forks,
a 15-second SSH connection timeout, a 60-second task timeout, and a ten-minute
overall limit. Local output/result files are capped at 1 MiB each and displayed
diagnostics at 16,384 characters. Temporary files and public identity references
are removed after completion. An empty inherited environment, private HOME,
application-controlled configuration and plugin paths isolate Ansible from user
configuration. Only builtin ping over SSH is exposed: no arbitrary commands,
playbooks, privilege escalation, group variables, scheduling or nested groups.

`pnpm nx run tower-desktop:test-ansible` runs the real Ansible runner against a
disposable loopback SSH server using generated keys and a separate SSH agent.
It requires `/usr/bin/ansible`, OpenSSH tools, `/usr/bin/python3` with Paramiko,
and loopback/Unix sockets. Its opt-in fixture executes the pipelined ping module
with a fixed local Python interpreter; it never executes received shell commands
or contacts production hosts. Browser group tests use mocked native IPC and
provide separate evidence for UI behavior.

## Ubuntu Server package updates

**Automation → Ubuntu package updates** uses the existing host/group selection.
Opening the task does not run updates. Choose **Preview updates**, review each
host's installed/proposed versions, then **Apply reviewed updates**. Preview
refreshes APT indexes and creates a root-owned plan; it installs no packages.
Previews expire after 15 minutes. Inventory changes require a fresh preview.

The initial scope is conservative package maintenance on Ubuntu Server:

- Remote requirements: Ubuntu, a running systemd system, `/usr/bin/python3`
  with `python3-apt`, trusted repositories, and SSH as root or with noninteractive
  passwordless sudo. The app never installs prerequisites or edits sudoers.
- Uses the existing isolated local Ansible process and hardened SSH identities
  and known-host verification. No caller-supplied commands, playbooks or paths.
- Checks free space (including `/boot`), the package database, and failed services.
  Repository refresh errors block the preview instead of silently using old indexes.
- Uses APT's conservative upgrade resolver: no new packages, removals, downgrades,
  held-package changes, or unauthenticated downloads. Common kernel, bootloader,
  firmware and initramfs packages are excluded; deferred updates are displayed.
  No release upgrades or reboots. Existing configuration files are retained using
  `--force-confdef` and `--force-confold`; package scripts may still restart services.
- Applies hosts sequentially and stops after a failure or an unconfirmed outcome.
  **Stop after current host** leaves the current installation running.
- Recomputes and compares exact package/version changes under APT's frontend lock,
  retaining that lock through installation. State changes or expired previews
  fail closed. Existing package-manager locks are respected, never deleted.
- Verifies installed versions, `dpkg --audit`, and newly failed systemd units.
  Reboot requirements are reported separately. Application endpoints are not
  checked, and a successful result is not proof of application compatibility.

The fixed helper is transported with
[`ansible.builtin.script`](https://docs.ansible.com/projects/ansible/latest/collections/ansible/builtin/script_module.html).
It uses Ubuntu's Python APT bindings to keep plan validation and installation
under the same frontend lock, rather than release the lock between simulation
and installation. Apply starts a unique systemd service on the server. Closing
the desktop or losing SSH does not kill that service or its package transaction.
After restarting the desktop, use **Refresh remote status**; the app never
resumes the remaining hosts automatically or launches the same reviewed run twice.

The latest run is atomically recorded in `package-updates.json` in the native
application data directory (mode 0600); a process lock prevents two desktop
instances from managing package updates there simultaneously. Remote plans,
results, and helper logs live under
`/var/lib/admin-tower/package-updates/<run-id>/`, with private root-owned files.
The service is named `admin-tower-apt-<run-id>.service`; package-manager output
is appended to `operation.log`. Records are retained for diagnosis and are not pruned
by this first version.

A launch without a terminal result is **Outcome unconfirmed**, never success.
A status check safely retires an unlaunched run so a delayed launch cannot follow.
If a service has disappeared without recording its result (for example after a
server reboot), inspect the service journal and package database on the server;
the app deliberately blocks another run while its outcome remains unconfirmed.
There is no automatic rollback or forced package repair.

Validation: `pnpm nx run tower-desktop:test` includes unprivileged Python helper
regressions and native journal/rollout tests. `pnpm nx run
tower-desktop:test-packages-transport` exercises real Ansible with a local,
unprivileged connection and verifies that preview/apply/status refuse privilege;
it cannot install packages. UI tests cover explicit review, frozen run IDs,
uncertain outcomes and mobile layout using mocked native IPC. These checks do
not establish a real Ubuntu installation or reboot outcome. Before production
use, validate an approved update on a disposable Ubuntu Server VM, including
SSH interruption, desktop restart, package/service failures and recovery.

OS release upgrades and dedicated kernel maintenance are later tasks.

## Host administration (Ubuntu/Debian)

Select a host's name in **Hosts** to open its administration page. The first
snapshot uses noninteractive SSH with the selected identity and existing host
trust. Tabs show OS/CPU/memory/uptime, filesystem capacity and block devices,
interfaces/routes/listening sockets, processes, users/groups, loaded and installed
systemd services, recent journal entries, and firewall rules. Structured results
use searchable, sortable tables with 25/50/100-row pagination. Column headers
support keyboard sorting; IDs, percentages, capacities and timestamps sort by
value. State filters narrow processes, network interfaces and services. Journal
entries separate timestamp, host, source and message; long cells expand on demand.

Account creation and service editors are collapsed until needed. In **Users &
groups**, select a user or group name to inspect linked memberships, with primary
and supplementary members shown separately. Search includes IDs, group names and
member names; filters identify UID 0 accounts, nologin/false shells and groups
without captured members. Review supplementary additions/removals from the
selected account's details. Primary memberships cannot be removed there. Shell
values do not establish authentication access, and counts reflect captured data.
Use a service row's **Manage** action to preselect its editor.
Original output and unrecognized lines remain available under collapsed details;
missing tools, denied access and truncated output are identified explicitly.
Firewall tables retain complete rules and original line/order numbers; sorting
the view does not change evaluation order. The Firewall tab has a dedicated source selector, chain/policy cards and filters
for chain/zone, action and rule text. nftables is collected as JSON and rendered
as actual rules, including match expressions, counters, comments and handles.
IPv4 and IPv6 iptables rules are grouped by table and chain, with policies
visible even for empty or collapsed chains. Sorting stays within each chain.
Chain jumps link to their target in the same table, and Back restores the previous
view. Separate source/destination ports, inline comments, explicit negated matches,
and optional interface and packet/byte columns make rules easier to inspect.
Original rule positions and complete conditions remain available. UFW status/defaults and firewalld runtime zone configuration are
presented separately. Exact definitions, sets/maps and diagnostics expand on
demand. Unsupported or truncated nftables documents are identified explicitly;
refresh older snapshots to collect the structured format. Source views can
overlap, so their counts are never summed as an overall firewall assessment.
See the [nftables JSON schema](https://manpages.debian.org/bookworm/libnftables1/libnftables-json.5.en.html)
for the read-only structured representation. The overview shows resource cards first, with
additional system and CPU properties available as tables under expandable panels.

The tables show timestamped, automatically refreshed snapshots; live monitoring is available separately in Processes. Individual tools can report denied, unavailable, timeout,
or error without hiding the remaining information.

Use **Refresh in terminal** when an SSH key needs a passphrase. **Inspect with
sudo** requests fuller journal, process and firewall visibility. Firewall
inspection includes nftables, IPv4/IPv6 iptables, UFW and firewalld where installed;
this version cannot edit firewall rules. Unprivileged journal output can be
incomplete even when the command succeeds. The remote host needs `/bin/sh` and
standard Debian/Ubuntu utilities (including `timeout` and `base64`); no agent or
Python installation is required on it. Missing optional tools are reported.

The **Users & groups** tab can create a local user (home, private group, locked
password), create a group, or add/remove supplementary membership. It cannot
remove a primary group, delete users, set passwords, or install SSH keys. The
**Services** tab supports start, stop, restart, reload, enable and disable of
systemd `.service` units; enable/disable only changes boot behavior. Changes are
rejected remotely unless `/etc/os-release` identifies Ubuntu or Debian.

Every terminal operation first displays the target, action, command and relevant
consequences in the app. A review expires after five minutes, is bound to the
saved host settings, and can be submitted only once. The helper revalidates the
review and identity and serializes terminal operations per inventory host.
Account/service changes are followed by a fresh privileged snapshot. Do not
blindly retry an interrupted operation: SSH loss, terminal closure or a timeout
can leave changes applied with an unknown outcome. Refresh and inspect first.
Closing/navigating away from the page does not cancel a remote operation.

Authentication happens in the external terminal. OpenSSH handles key passphrases;
`sudo -S` reads its password through SSH's inherited terminal input, with local
echo disabled and restored afterwards. Admin-Tower has no password field and
never reads or persists credential input. The SSH account must already be
permitted to use sudo for the generated shell operation (or be root); the app
does not install or modify sudoers rules. Hosts configured to require a remote
TTY for sudo are not supported by this capture flow. See the
[Debian sudo manual](https://manpages.debian.org/bookworm/sudo/sudo.8.en.html)
and [useradd defaults](https://manpages.debian.org/bookworm/passwd/useradd.8.en.html).

Each inspection command has an eight-second deadline and displays at most
128 KiB; total SSH output is capped at 4 MiB. Automatic inspection has a
90-second deadline and terminal operations have a 225-second deadline including
authentication. Timing out the local SSH client does not guarantee remote
rollback or cancellation. Journal output is limited to 150 entries; process
command arguments and password database fields are excluded from collection.

Reviewed requests and terminal results are stored as `0600` files under the
`0700` application-data `operations/` directory. Snapshots can contain sensitive
network, account and journal information. Recognized operation files older than
24 hours are removed on subsequent operation access, not by a background timer.
Unprivileged automatic snapshots remain in app memory. Native IPC exposes only
typed actions, not an arbitrary shell command, and retains the local-main-window
capability restriction. This boundary does not defend against a compromised
local account or compromised remote host.

### Workspace navigation and refresh

The host toolbar keeps the target, section navigation and common actions together.
Switch hosts directly from its selector, or open Services/Processes straight from
an inventory row. Inventory search includes names, addresses and SSH users, with
sorting by each field. New-user/new-group shortcuts focus the corresponding field.
Service rows offer state-appropriate Start, Restart, Stop or boot-state actions;
each opens the existing review in a keyboard-accessible dialog before execution.
Escape cancels the review and restores focus to its originating control.

Section links support browser Back/Forward and `?tab=services`-style deep links.
Use Alt+1 through Alt+8 to switch sections, or `/` to focus the current section's
search. These shortcuts do not intercept typing or the embedded terminal.
Tables and account/firewall views load on first visit and retain filters, sorting
and pagination while switching sections on the same host. Selecting another host
resets that context. The sidebar stays open after desktop navigation.

Noninteractive snapshots refresh automatically 15 seconds after the previous
request completes; select 30 seconds, 60 seconds or Off in the toolbar. Existing
data remains visible and usable during refresh, unchanged section objects are
reused, and requests never overlap within a host view. Refresh pauses while the
app is hidden, a review or operation is active, or a privileged snapshot is shown.
Privileged snapshots require an explicit refresh to avoid silently replacing them
with less complete unprivileged results. SSH latency and collection time determine
actual snapshot freshness; only the separate htop view streams live process data.

### Live htop

Open **Processes → Start live htop** in the Linux desktop app for an embedded,
interactive terminal running the host's actual `htop`, updated about once a
second. Search, filter, sorting, tree view and keyboard navigation work inside
this view. The sortable process snapshot remains below it.

The remote host must have `/usr/bin/htop` with `--readonly` support. Admin-Tower
always enables that mode: process changes are disabled, and there is no sudo,
shell fallback or automatic installation. Authentication is noninteractive and
uses the saved SSH identity and verified host trust. For an encrypted key, load
it into your agent externally and select that **agent identity** in the host's
settings. This view never prompts for credentials.

Stop ends the session. Leaving the Processes tab, changing the host settings or
closing the app also stops its local SSH client. Sessions expire after one hour,
or after 20 seconds without UI polling. Output stays in memory and is not logged
by the app; htop can display sensitive process arguments. Terminal clipboard
writes are blocked. The embedded renderer is [xterm.js](https://xtermjs.org/);
the process viewer is [htop](https://github.com/htop-dev/htop).

### Verification

```sh
pnpm nx lint tower-ui
pnpm nx test tower-ui
pnpm nx build tower-ui
pnpm nx e2e tower-ui-e2e
pnpm nx test tower-desktop
pnpm nx run tower-desktop:check
pnpm nx run tower-desktop:test-ssh
pnpm nx run tower-desktop:test-ansible
pnpm nx run tower-desktop:test-terminal
pnpm nx build tower-desktop
```

The SSH integration target requires Python 3 with `paramiko`, system `ssh`,
`ssh-keygen`, `ssh-agent`, `ssh-add`, and `htop` with read-only support, and permission to open loopback/Unix
sockets. It creates disposable keys, a loopback SSH server, and a separate agent;
it never uses the user's SSH keys or trust file. It verifies exact identity
selection, unknown/changed host rejection, hashed host entries, and disabled
fallbacks. It also transports complete/malformed administration snapshots over
real SSH without executing received commands on the fixture server. A separate
fixture starts a fixed local read-only htop and verifies streaming, resizing,
keyboard input and session cleanup through SSH. Native tests
cover review expiry/host binding, single use, locking, shell validation and a
read-only local collector. Browser E2E tests mock native IPC; native tests separately exercise
Tauri's origin/window permissions. Install the matching Playwright browsers with
`pnpm exec playwright install` before running E2E.

The optional `test-terminal` target requires a graphical desktop and briefly opens
each installed supported terminal with a harmless argument-recording fixture. It
does not start SSH or use any user credentials.

### Live automation logs

Ping and Ubuntu package updates show a **Live logs** panel with a selectable
**Follow output** option. Ping streams Ansible's verbose command output. Package
previews stream executed commands and output; installations also capture native
APT/dpkg output in the remote `operation.log`. Installation uses the Python APT
API, so the log labels that operation rather than inventing an `apt-get` command.
The panel displays the latest 64 KiB, refreshed every few seconds while running
(connection latency can increase this). Log transport uses the same selected
SSH identity and trusted-host checks; a log failure does not cancel maintenance.
Logs are displayed as plain text. Desktop log tails are session-only; full package
logs remain on the host, and refreshing an unresolved run fetches its tail again.

## Reviewed Ubuntu reboots

The inventory row Reboot button starts a single-host reboot with one click. It
runs preflight first, then submits that fresh review automatically if all checks
pass. Compact progress and outcomes stay inline; detailed logs are available on the reboot automation page. There is no acknowledgement checkbox for this
shortcut; clicking it authorizes the service interruption. Failed or uncertain
requests are never automatically resubmitted.

Open **Automation → Reboot Ubuntu hosts**, or choose **Review reboot** beside a
pending reboot in package results. Opening the screen never submits a reboot.
Select hosts/groups, run **Review reboot**, inspect the frozen host list and any
packages named in Ubuntu's reboot-required marker, acknowledge downtime, then
choose **Reboot N hosts now**. Reviews expire after 15 minutes and are invalidated
by changed inventory settings or a changed boot ID. A reboot can activate an
already installed kernel; it does not install deferred updates.

The task uses [`ansible.builtin.reboot`](https://docs.ansible.com/projects/ansible/latest/collections/ansible/builtin/reboot_module.html)
with the existing isolated Ansible configuration, selected SSH identity, strict
host-key verification and noninteractive sudo. A fixed remote dispatch guard
checks Ubuntu/systemd, package database health and APT/dpkg locks, then records
an at-most-once claim before requesting shutdown. No arbitrary caller command
or automatic reboot is exposed. Package tasks and reboots are mutually blocked
while either has an active or unconfirmed run in this desktop's durable state.

Review and dispatch both validate `/usr/sbin/sshd -t` and require a persistently
enabled, active `ssh.service` or `ssh.socket`, with a loaded SSH service and no
pending daemon reload for the selected activation path. Runtime-only enablement
does not qualify. The review shows the verified activation path; a failed check
blocks reboot without changing SSH configuration. Ubuntu socket activation is
supported even when `ssh.service` itself is disabled. The guarded reboot command
is `/usr/sbin/shutdown -r now "Reboot requested through Admin-Tower"`.

Hosts run sequentially. Verification requires a changed boot ID, working SSH,
and systemd reaching `running` or `degraded`. Additional failed services stop
remaining hosts and are reported separately; application endpoints are not
checked. The Ansible wait is bounded (up to 600 seconds each for boot verification
and readiness), and live command output is available in the task screen.

**Stop after current host** and closing the desktop do not undo a submitted
reboot. State is journaled in `reboots.json` before dispatch; an interrupted
request becomes **Outcome unconfirmed**. **Refresh reboot status** only observes:
it never calls the reboot module. If no dispatch exists, it retires the remote
review under the same lock used by the dispatch guard, preventing a delayed
request from rebooting after the UI reports that nothing was submitted. The app
never automatically resumes remaining hosts or retries an uncertain reboot.
Remote dispatch records live in `/var/lib/admin-tower/reboots/<run-id>/` and are
retained for diagnosis. Live log tails are session-only.

Validation includes unprivileged guard/lock/recovery tests and
`pnpm nx run tower-desktop:test-reboot-transport`, which exercises the real Ansible
module against a disposable SSH server that simulates boot changes and connection
loss, never executing shutdown. Browser tests use mocked desktop commands.
Actual VM/physical-host reboot and application recovery remain operator acceptance
checks; development validation does not reboot production hosts.
