export const PING_TASK = {
  id: 'ping',
  name: 'Ping',
  category: 'Connectivity',
  description: 'Check SSH access and Python availability on individual hosts or multiple groups.',
  route: '/automation/ping',
  documentation: 'https://docs.ansible.com/projects/ansible/latest/collections/ansible/builtin/ping_module.html',
} as const;

export const AUTOMATION_TASKS = [PING_TASK] as const;
