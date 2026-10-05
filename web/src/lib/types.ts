export type Presence = 'available' | 'thinking' | 'working' | 'browsing' | 'coding' | 'waiting' | 'watching' | 'scheduled' | 'needs_you' | 'blocked' | 'idle' | 'recovering' | 'listening';
export interface Identity { id: string; name: string; userName?: string; presence: Presence; narration: string; subject?: string; updatedAt: number }
export interface Step { idx: number; key: string; title: string; state: string; narration?: string; startedAt?: number; endedAt?: number; attempts: number }
export interface Task {
  id: string; title: string; goal?: string; state: string; playbook: string; spaceId?: string; responsibilityId?: string; nowLine?: string;
  currentStep: number; stepCount: number; attention?: string | null; priority: number; result?: string; error?: string; retryCount: number; maxRetries: number;
  nextEventAt?: number; waitingOn?: string; cost: number; createdAt: number; startedAt?: number; completedAt?: number; updatedAt: number; origin: any; steps: Step[];
  parentTaskId?: string; depth: number; plan: { title: string; status: string }[]; verification: { verdict: 'pass' | 'fail' | 'unknown'; issues: string[]; summary: string; round: number } | null;
  diagnosis?: string; recoveries: number; criteria?: string | null; children: { id: string; title: string; state: string }[];
  ownerId?: string; agentId?: string | null; rating?: number | null; agent?: { id: string; name: string; emoji: string; color: string } | null;
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
export interface Message { id: string; conversationId: string; role: 'user' | 'auda'; content: string; objects: { type: string; id: string }[]; channel: string; createdAt: number; authorType: 'user' | 'auda' | 'agent'; authorId?: string; authorName: string; authorState?: string | null; attachments: string[] }
export interface Pairing { id: string; name: string; platform?: string; code: string; state: string; createdAt: number; expiresAt: number }
export interface Client { id: string; name: string; platform?: string; createdAt: number; lastSeenAt?: number; revokedAt?: number }
export interface Agent { id: string; name: string; kind: 'coordinator' | 'agent' | 'subagent' | 'custom'; state: string; nowLine?: string; parentId?: string; emoji?: string; color?: string }
export interface Member { id: string; email: string; name: string; role: 'owner' | 'admin' | 'member'; createdAt: number; lastSeenAt?: number; disabled: boolean; hasPassword: boolean }
export interface PluginTool { name: string; description: string; readOnly: boolean }
export interface Plugin {
  id: string; name: string; kind: 'openapi' | 'mcp'; preset?: string | null; description?: string | null; icon: string; visibility: 'org' | 'private';
  createdBy?: string; mine: boolean; canManage: boolean; auth: 'oauth2' | 'apiKey' | 'bearer' | 'none'; oauthReady: boolean; discovered: boolean;
  baseUrl?: string; mcpUrl?: string; redirectUri: string; setup?: string; tools: PluginTool[];
  connection: { state: string; account?: string | null; error?: string | null; expiresAt?: number | null; updatedAt: number } | null; connectedUsers: number;
}
export interface Preset { id: string; name: string; icon: string; description: string; kind: string; setup: string; auth: string; tools: number }
export interface CustomAgent {
  id: string; name: string; emoji: string; color: string; description?: string; instructions: string; template?: string | null; visibility: 'private' | 'org';
  ownerId: string; ownerName: string; mine: boolean; canEdit: boolean; plugins: string[] | null; tools: string[] | null; effort?: string | null; criteria?: string | null; starters: string[];
  sources: { id: string; url: string; everyHours: number; lastFetchedAt?: number | null; error?: string | null }[]; study: boolean; reflect: boolean;
  knowledge: { documents: number; lessons: number; skills: number; chars: number; passages: number; embedder: string };
  stats: { tasks: number; completed: number; active: number; rating: number | null; rated: number };
  learning: { updates: number; history: { at: number; labelled: number; positives: number; accuracy: number | null; lessons: number }[]; weights: number[] };
  createdAt: number; updatedAt: number;
}
export interface KbDocument { id: string; title: string; source: string; sourceRef?: string; kind: 'doc' | 'lesson' | 'skill'; chars: number; passages: number; confidence: number; uses: number; helpful: number; state: string; error?: string; createdAt: number; updatedAt: number }
export interface Conversation { id: string; title: string; channel: string; spaceId?: string; updatedAt: number }
export interface Space { id: string; name: string; slug: string; description?: string; icon?: string }
export interface Device { id: string; name: string; state: string; platform?: string; grants: Record<string, boolean>; lastSeenAt?: number; createdAt: number; revokedAt?: number }
export interface Service { name: string; running: boolean; pid?: number; logLevel?: string; path: string }
export interface Computer { id: string; name: string; state: string; controller: 'auda' | 'human'; driver: { driver: string; label: string; home: string }; browser: { available: boolean; running: boolean; url: string; activity: { action: string; url: string; ts: number } | null }; services: Service[] }
export interface Capability { id: string; title: string; group: string; risk: string; default: string; level: string }
export interface Settings {
  notificationPrefs: Record<string, string>; notificationWebhook: string; sound: boolean; concurrency: number;
  models: { roles: Record<string, { provider: string; model: string }>; dailyBudget?: number; monthlyBudget?: number; local?: { baseUrl: string; model: string; kind?: string; tools?: boolean; contextLength?: number; manage?: boolean; desiredContext?: number; api?: string; tps?: number }; anthropicConnected: boolean; anthropicFromEnv: boolean; localSetup?: LocalSetupState | null; lms?: boolean };
  spend: { today: number; month: number }; capabilities: Capability[]; agentVerify: boolean; agentWebSearch: boolean; instanceName: string; requirePairing: boolean;
}

export interface LocalSetupStep { id: string; label: string; state: 'pending' | 'active' | 'done' | 'failed' | 'skipped'; detail?: string }
export interface LocalSuggestion { key: string; name: string; gb: number; why: string; recommended?: boolean }
export interface LocalRanked { id: string; score: number; tools: 'yes' | 'likely' | 'no'; fits: 'fast' | 'slow' | 'no' | 'unknown'; gb?: number; context?: number; loaded: boolean; reasons: string[] }
export interface LocalHardware { summary: string; totalGb: number; fastGb: number; maxGb: number; gpus: { name: string; vramGb: number }[]; unified: boolean; platform: string }
export interface LocalSetupState {
  running: boolean; auto: boolean; firstRun: boolean; startedAt: number; finishedAt?: number; baseUrl?: string; steps: LocalSetupStep[];
  download?: { model: string; pct: number; downloadedBytes: number; totalBytes: number; bytesPerSecond?: number; eta?: string };
  outcome?: 'connected' | 'text-only' | 'needs-model' | 'no-server' | 'failed'; message?: string; suggestions?: LocalSuggestion[]; ranked?: LocalRanked[]; hardware?: LocalHardware;
  result?: { model: string; context?: number; tps?: number; tools: boolean; embeddings?: string };
}
