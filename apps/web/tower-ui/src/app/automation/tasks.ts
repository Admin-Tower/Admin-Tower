export const PING_TASK = {
  id: 'ping',
  name: 'Ping',
  category: 'Connectivity',
  description: 'Check SSH access and Python availability on individual hosts or multiple groups.',
  route: '/automation/ping',
  documentation: 'https://docs.ansible.com/projects/ansible/latest/collections/ansible/builtin/ping_module.html',
} as const;

export const PACKAGES_TASK = {
  id: 'packages',
  name: 'Ubuntu package updates',
  category: 'Maintenance',
  description: 'Preview and apply Ubuntu Server package updates, one host at a time.',
  route: '/automation/packages',
} as const;

export const REBOOT_TASK = {
  id: 'reboot',
  name: 'Reboot Ubuntu hosts',
  category: 'Maintenance',
  description: 'Review and confirm a reboot, then verify each host comes back online.',
  route: '/automation/reboot',
} as const;

export const AUTOMATION_TASKS = [PING_TASK, PACKAGES_TASK, REBOOT_TASK] as const;
