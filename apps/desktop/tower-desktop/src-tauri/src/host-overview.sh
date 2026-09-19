# Executed remotely through system OpenSSH. Never source remote configuration files.
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin SYSTEMD_PAGER=cat SYSTEMD_COLORS=0
set -f
section() {
  section_name=$1
  shift
  section_output=$(timeout 8s "$@" 2>&1)
  section_status=$?
  printf 'AT1\t%s\t%s\t' "$section_name" "$section_status"
  printf '%s' "$section_output" | head -c 131072 | base64 -w0
  printf '\n'
}
printf 'AT1\tprotocol\t0\tMQ==\n'
section system sh -c '
  cat /etc/os-release
  printf "\nHostname: "; hostname
  printf "Kernel: "; uname -srmo
  printf "Uptime: "; uptime -p
  printf "Logical CPUs: "; getconf _NPROCESSORS_ONLN
  printf "Load: "; cat /proc/loadavg
  printf "\nMemory (KiB):\n"; cat /proc/meminfo
'
section cpu lscpu
section storage df -hPT
section disks lsblk -P -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT
section interfaces ip -brief address
section routes ip route show table all
section routes6 ip -6 route show table all
section ports ss -lntup
section processes ps -eo pid,ppid,user,pcpu,pmem,stat,comm --sort=-pcpu
section users sh -c 'entries=$(getent passwd); code=$?; printf "%s\n" "$entries" | cut -d: -f1,3,4,5,6,7; exit "$code"'
section groups sh -c 'entries=$(getent group); code=$?; printf "%s\n" "$entries" | cut -d: -f1,3,4; exit "$code"'
section services systemctl list-units --type=service --all --no-pager --no-legend --plain
section serviceFiles systemctl list-unit-files --type=service --no-pager --no-legend
section failedServices systemctl --failed --type=service --no-pager --no-legend --plain
section logs journalctl -n 150 --no-pager -o short-iso
section nftables nft -j -a list ruleset
section iptables iptables-save -c
section ip6tables ip6tables-save -c
section ufw ufw status verbose
section firewalld firewall-cmd --list-all-zones
printf 'AT1\tcomplete\t0\tMQ==\n'
