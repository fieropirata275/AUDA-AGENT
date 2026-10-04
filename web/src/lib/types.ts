export type Presence = 'available' | 'thinking' | 'working' | 'browsing' | 'coding' | 'waiting' | 'watching' | 'scheduled' | 'needs_you' | 'blocked' | 'idle' | 'recovering' | 'listening';
export interface Identity { id: string; name: string; userName?: string; presence: Presence; narration: string; subject?: string; updatedAt: number }
export interface Step { idx: number; key: string; title: string; state: string; narration?: string; startedAt?: number; endedAt?: number; attempts: number }
export interface Task {
  id: string; title: string; goal?: string; state: string; playbook: string; spaceId?: string; responsibilityId?: string; nowLine?: string;
  currentStep: number; stepCount: number; attention?: string | null; priority: number; result?: string; error?: string; retryCount: number; maxRetries: number;
  nextEventAt?: number; waitingOn?: string; cost: number; createdAt: number; startedAt?: number; completedAt?: number; updatedAt: number; origin: any; steps: Step[];
}
export interface Watcher { id: string; kind: string; description: string; intervalSec: number; lastValue?: string; lastCheckedAt?: number; nextCheckAt?: number; enabled: boolean; errors: number; history: [number, number][] | null; armed: boolean | null }
export interface Schedule { id: string; ownerType: string; ownerId: string; kind: string; spec: string; description: string; nextRunAt?: number; windowEnd?: number; lastRunAt?: number; enabled: boolean }
export interface Responsibility {
  id: string; title: string; description?: string; playbook: string; state: string; spaceId?: string; config: any; statusLine?: string;
  lastTriggeredAt?: number; lastOutcome?: string; triggerCount: number; createdAt: number; updatedAt: number; watchers: Watcher[]; schedules: Schedule[]; triggers: any[]; tasks: number; origin: any;
}
export interface Approval {
  id: string; taskId: string; capability: string; title: string; summary: string; recommendation?: string; impact?: string; ifYes?: string; ifNo?: string;
  approveLabel?: string; rejectLabel?: string; evidence: { label: string; value: string }[]; actions: { capability: string; describe: string; level: string }[];
  state: 'pending' | 'approved' | 'rejected' | 'expired'; decidedAt?: number; createdAt: number; task: { title: string; responsibilityId?: string } | null;
}
export interface Activity { id: string; ts: number; kind: string; title: string; detail?: string; taskId?: string; responsibilityId?: string; spaceId?: string; hasRaw: boolean }
export interface Memory {
  id: string; kind: string; title: string; content: string; source: string; sourceRef?: string; confidence: number; scope: string; spaceId?: string; responsibilityId?: string;
  weight: 'mentioned' | 'established' | 'defining'; pinned: boolean; sensitivity: string; expiresAt?: number; reinforced: number; supersededBy?: string; createdAt: number; updatedAt: number; data: any;
}
export interface Artifact { id: string; name: string; path: string; mime: string; size: number; why: string; taskId?: string; responsibilityId?: string; spaceId?: string; createdAt: number; taskTitle?: string }
export interface Connector { id: string; kind: string; name: string; state: string; detail?: string; error?: string; lastOkAt?: number; config: any; capabilities: { id: string; title: string; level: string }[] }
export interface CatalogItem { kind: string; name: string; description: string; capabilities: string[]; available: boolean; setup?: string; tokenHelp?: string }
export interface Rule { id: string; text: string; compiled: any; interpretation: string; state: 'draft' | 'active' | 'disabled'; spaceId?: string; origin?: string; createdAt: number; activatedAt?: number; hits: number }
export interface Notification { id: string; level: string; title: string; body?: string; subjectType?: string; subjectId?: string; delivered: boolean; suppressedReason?: string; readAt?: number; createdAt: number }
export interface Message { id: string; conversationId: string; role: 'user' | 'auda'; content: string; objects: { type: string; id: string }[]; channel: string; createdAt: number }
export interface Conversation { id: string; title: string; channel: string; spaceId?: string; updatedAt: number }
export interface Space { id: string; name: string; slug: string; description?: string; icon?: string }
export interface Device { id: string; name: string; state: string; platform?: string; grants: Record<string, boolean>; lastSeenAt?: number; createdAt: number; revokedAt?: number }
export interface Service { name: string; running: boolean; pid?: number; logLevel?: string; path: string }
export interface Computer { id: string; name: string; state: string; controller: 'auda' | 'human'; driver: { driver: string; label: string; home: string }; browser: { available: boolean; running: boolean; url: string; activity: { action: string; url: string; ts: number } | null }; services: Service[] }
export interface Capability { id: string; title: string; group: string; risk: string; default: string; level: string }
export interface Settings {
  notificationPrefs: Record<string, string>; notificationWebhook: string; sound: boolean; concurrency: number;
  models: { roles: Record<string, { provider: string; model: string }>; dailyBudget?: number; monthlyBudget?: number; local?: { baseUrl: string; model: string }; anthropicConnected: boolean; anthropicFromEnv: boolean };
  spend: { today: number; month: number }; capabilities: Capability[];
}
