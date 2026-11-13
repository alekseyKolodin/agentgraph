// Фикстуры для тестов логики Teamwork: задача с обязательными полями контракта. В интерфейсе не используется.
import type { TeamTask } from '@server/api-types';

export const task = (over: Partial<TeamTask> & { id: string }): TeamTask => ({
  title: over.id, type: 'feature', status: 'todo', rank: 'V', blockedBy: [], covers: [], body: '', acceptance: { done: 0, total: 0 }, comments: 0, base: 'h', file: `tasks/${over.id}.md`,
  ...over,
});
