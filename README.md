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

These are snapshots,
not live monitoring. Individual tools can report denied, unavailable, timeout,
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

### Verification

```sh
pnpm nx lint tower-ui
pnpm nx test tower-ui
pnpm nx build tower-ui
pnpm nx e2e tower-ui-e2e
pnpm nx test tower-desktop
pnpm nx run tower-desktop:check
pnpm nx run tower-desktop:test-ssh
pnpm nx run tower-desktop:test-terminal
pnpm nx build tower-desktop
```

The SSH integration target requires Python 3 with `paramiko`, system `ssh`,
`ssh-keygen`, `ssh-agent`, and `ssh-add`, and permission to open loopback/Unix
sockets. It creates disposable keys, a loopback SSH server, and a separate agent;
it never uses the user's SSH keys or trust file. It verifies exact identity
selection, unknown/changed host rejection, hashed host entries, and disabled
fallbacks. It also transports complete/malformed administration snapshots over
real SSH without executing received commands on the fixture server. Native tests
cover review expiry/host binding, single use, locking, shell validation and a
read-only local collector. Browser E2E tests mock native IPC; native tests separately exercise
Tauri's origin/window permissions. Install the matching Playwright browsers with
`pnpm exec playwright install` before running E2E.

The optional `test-terminal` target requires a graphical desktop and briefly opens
each installed supported terminal with a harmless argument-recording fixture. It
does not start SSH or use any user credentials.
