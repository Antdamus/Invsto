/* Shared responsibility rules for task lists and dashboards. No writes here. */
(function (root) {
  'use strict';
  const finished = new Set(['resolved', 'cancelled', 'approved_by_admin', 'approved_for_shipping', 'shipped_completed', 'closed']);
  const review = new Set(['completed_by_employee', 'pending_admin_review', 'ready_for_admin_approval', 'waiting_on_admin']);
  const owner = task => task.assigned_to_user_id || null;
  const person = (id, people) => people.find(p => p.user_id === id && p.active !== false);
  function reviewer(task, people = []) {
    const completedBy = owner(task);
    if (task.status !== 'completed_by_employee') {
      const assigned = person(owner(task), people);
      if (assigned?.role === 'admin') return assigned.user_id;
    }
    for (const id of [task.assigned_by, task.created_by]) {
      const employee = person(id, people);
      if (id && id !== completedBy && employee && (task.status === 'completed_by_employee' || employee.role === 'admin')) return id;
    }
    return people.filter(p => p.active !== false && p.role === 'admin' && p.user_id && p.user_id !== completedBy)
      .sort((a, b) => a.user_id.localeCompare(b.user_id))[0]?.user_id || null;
  }
  function next(task, people = []) {
    if (finished.has(task.status)) return {kind: 'history', userId: null};
    if (review.has(task.status)) return {kind: 'approval', userId: reviewer(task, people)};
    if (task.status === 'waiting_on_subtasks') return {kind: 'subtasks', userId: null};
    return {kind: 'work', userId: owner(task)};
  }
  function related(task, userId, following = []) {
    return Boolean(userId && ([owner(task), task.assigned_by, task.created_by, task.resolved_by, task.metadata?.task_workflow?.completed_by].includes(userId)
      || following.some(f => f.source === task.source && f.task_id === task.id)));
  }
  function bucket(task, userId, people = [], following = []) {
    const action = next(task, people);
    if (action.kind === 'history') return related(task, userId, following) ? 'history' : null;
    if (action.userId === userId) return action.kind === 'approval' ? 'approvals' : 'assigned';
    return related(task, userId, following) ? 'following' : null;
  }
  function label(task, people = [], userId = null) {
    const action = next(task, people);
    if (action.kind === 'history') return task.status === 'cancelled' ? 'Canceled' : 'Finished';
    if (action.kind === 'subtasks') return 'Waiting for subtasks';
    const employee = person(action.userId, people);
    const name = action.userId === userId ? 'You' : employee?.display_name || employee?.name || employee?.email
      || (action.kind === 'work' ? task.assigned_to_email : '') || (action.kind === 'approval' ? 'Reviewer needed' : 'Unassigned');
    return `${action.kind === 'approval' ? 'Review' : 'Next'}: ${name}`;
  }
  root.OGTaskWorkflow = Object.freeze({finished, review, reviewer, next, related, bucket, label});
})(globalThis);
