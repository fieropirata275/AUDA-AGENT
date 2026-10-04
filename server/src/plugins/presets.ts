/**
 * Ready-made plugins for common external apps. An admin registers an OAuth app
 * once (client id/secret, with AUDA's redirect URI); then every member connects
 * their own account. Tools are plain HTTP calls the agents can make on the
 * member's behalf; anything that changes data is a write and asks first.
 */
export interface PluginTool {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;                       // may contain {param}
  input_schema: { type: 'object'; properties: Record<string, any>; required?: string[] };
  readOnly: boolean;
  /** Which inputs go into the query string (the rest of non-path inputs go to the JSON body). */
  query?: string[];
  /** Send this input as the whole JSON body instead of the remaining fields. */
  bodyParam?: string;
}
export interface PluginAuth {
  type: 'oauth2' | 'apiKey' | 'bearer' | 'none';
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  clientId?: string;
  extraAuthParams?: Record<string, string>;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  /** MCP: discover the authorization server and register dynamically. */
  discovered?: boolean;
  resource?: string;
  registrationUrl?: string;
  /** How the client authenticates at the token endpoint. */
  tokenAuth?: 'body' | 'basic';
}
export interface PluginConfig { auth: PluginAuth; baseUrl?: string; mcpUrl?: string; tools: PluginTool[]; headers?: Record<string, string>; docs?: string }
export interface Preset { id: string; name: string; icon: string; description: string; kind: 'openapi' | 'mcp'; config: PluginConfig; setup: string }

const S = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required });

export const PRESETS: Preset[] = [
  {
    id: 'github', name: 'GitHub', icon: 'code', kind: 'openapi', description: 'Search code, read issues and pull requests, comment.',
    setup: 'Create an OAuth App in GitHub → Settings → Developer settings, with the callback URL shown here.',
    config: {
      baseUrl: 'https://api.github.com',
      auth: { type: 'oauth2', authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', scopes: ['repo', 'read:user'] },
      tools: [
        { name: 'search_issues', description: 'Search issues and pull requests (GitHub search syntax).', method: 'GET', path: '/search/issues', query: ['q', 'per_page'], input_schema: S({ q: { type: 'string' }, per_page: { type: 'number' } }, ['q']), readOnly: true },
        { name: 'get_issue', description: 'Read an issue or PR with its body.', method: 'GET', path: '/repos/{owner}/{repo}/issues/{number}', input_schema: S({ owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'number' } }, ['owner', 'repo', 'number']), readOnly: true },
        { name: 'search_code', description: 'Search code across repositories.', method: 'GET', path: '/search/code', query: ['q'], input_schema: S({ q: { type: 'string' } }, ['q']), readOnly: true },
        { name: 'comment', description: 'Comment on an issue or PR.', method: 'POST', path: '/repos/{owner}/{repo}/issues/{number}/comments', input_schema: S({ owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'number' }, body: { type: 'string' } }, ['owner', 'repo', 'number', 'body']), readOnly: false },
      ],
    },
  },
  {
    id: 'google-calendar', name: 'Google Calendar', icon: 'calendar', kind: 'openapi', description: 'Read your schedule and create events.',
    setup: 'Create an OAuth client (Web application) in Google Cloud Console → APIs & Services, enable the Calendar API, and add the redirect URI shown here.',
    config: {
      baseUrl: 'https://www.googleapis.com/calendar/v3',
      auth: { type: 'oauth2', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/calendar'], extraAuthParams: { access_type: 'offline', prompt: 'consent' } },
      tools: [
        { name: 'list_events', description: 'List upcoming events (RFC3339 timeMin/timeMax).', method: 'GET', path: '/calendars/primary/events', query: ['timeMin', 'timeMax', 'q', 'maxResults', 'singleEvents', 'orderBy'], input_schema: S({ timeMin: { type: 'string' }, timeMax: { type: 'string' }, q: { type: 'string' }, maxResults: { type: 'number' }, singleEvents: { type: 'boolean' }, orderBy: { type: 'string' } }), readOnly: true },
        { name: 'create_event', description: 'Create an event. start/end: {"dateTime": RFC3339}.', method: 'POST', path: '/calendars/primary/events', input_schema: S({ summary: { type: 'string' }, description: { type: 'string' }, start: { type: 'object' }, end: { type: 'object' }, attendees: { type: 'array' } }, ['summary', 'start', 'end']), readOnly: false },
      ],
    },
  },
  {
    id: 'google-drive', name: 'Google Drive', icon: 'folder', kind: 'openapi', description: 'Find and read files in Drive.',
    setup: 'Same Google OAuth client as Calendar, with the Drive API enabled.',
    config: {
      baseUrl: 'https://www.googleapis.com/drive/v3',
      auth: { type: 'oauth2', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/drive.readonly'], extraAuthParams: { access_type: 'offline', prompt: 'consent' } },
      tools: [
        { name: 'search_files', description: 'Search files (Drive query syntax, e.g. name contains \'quote\').', method: 'GET', path: '/files', query: ['q', 'pageSize', 'fields'], input_schema: S({ q: { type: 'string' }, pageSize: { type: 'number' }, fields: { type: 'string' } }), readOnly: true },
        { name: 'export_doc', description: 'Export a Google Doc as plain text.', method: 'GET', path: '/files/{fileId}/export', query: ['mimeType'], input_schema: S({ fileId: { type: 'string' }, mimeType: { type: 'string', description: 'text/plain' } }, ['fileId', 'mimeType']), readOnly: true },
      ],
    },
  },
  {
    id: 'gmail', name: 'Gmail', icon: 'mail', kind: 'openapi', description: 'Search and read mail; draft replies. Sending always asks.',
    setup: 'Same Google OAuth client, with the Gmail API enabled.',
    config: {
      baseUrl: 'https://gmail.googleapis.com/gmail/v1/users/me',
      auth: { type: 'oauth2', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/gmail.modify'], extraAuthParams: { access_type: 'offline', prompt: 'consent' } },
      tools: [
        { name: 'search', description: 'Search messages (Gmail search syntax). Returns ids.', method: 'GET', path: '/messages', query: ['q', 'maxResults'], input_schema: S({ q: { type: 'string' }, maxResults: { type: 'number' } }, ['q']), readOnly: true },
        { name: 'read', description: 'Read a message.', method: 'GET', path: '/messages/{id}', query: ['format'], input_schema: S({ id: { type: 'string' }, format: { type: 'string', description: 'full | metadata' } }, ['id']), readOnly: true },
        { name: 'create_draft', description: 'Create a draft. message.raw is a base64url RFC 2822 email.', method: 'POST', path: '/drafts', input_schema: S({ message: { type: 'object' } }, ['message']), readOnly: false },
      ],
    },
  },
  {
    id: 'slack', name: 'Slack', icon: 'chat', kind: 'openapi', description: 'Read channels and post messages.',
    setup: 'Create a Slack app with OAuth & Permissions → User Token Scopes (search:read, channels:history, chat:write) and the redirect URL shown here.',
    config: {
      baseUrl: 'https://slack.com/api',
      auth: { type: 'oauth2', authorizeUrl: 'https://slack.com/oauth/v2/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.access', scopes: [], extraAuthParams: { user_scope: 'search:read,channels:history,chat:write' } },
      tools: [
        { name: 'search_messages', description: 'Search messages.', method: 'GET', path: '/search.messages', query: ['query', 'count'], input_schema: S({ query: { type: 'string' }, count: { type: 'number' } }, ['query']), readOnly: true },
        { name: 'post_message', description: 'Post a message to a channel.', method: 'POST', path: '/chat.postMessage', input_schema: S({ channel: { type: 'string' }, text: { type: 'string' } }, ['channel', 'text']), readOnly: false },
      ],
    },
  },
  {
    id: 'notion', name: 'Notion', icon: 'doc', kind: 'openapi', description: 'Search and read pages.',
    setup: 'Create a public integration at notion.so/my-integrations with the redirect URI shown here.',
    config: {
      baseUrl: 'https://api.notion.com/v1',
      headers: { 'Notion-Version': '2022-06-28' },
      auth: { type: 'oauth2', tokenAuth: 'basic', authorizeUrl: 'https://api.notion.com/v1/oauth/authorize', tokenUrl: 'https://api.notion.com/v1/oauth/token', scopes: [], extraAuthParams: { owner: 'user' } },
      tools: [
        { name: 'search', description: 'Search pages and databases.', method: 'POST', path: '/search', input_schema: S({ query: { type: 'string' } }, ['query']), readOnly: true },
        { name: 'page_content', description: 'Read the blocks of a page.', method: 'GET', path: '/blocks/{page_id}/children', input_schema: S({ page_id: { type: 'string' } }, ['page_id']), readOnly: true },
      ],
    },
  },
  {
    id: 'linear', name: 'Linear', icon: 'list', kind: 'openapi', description: 'Query and create issues (GraphQL).',
    setup: 'Create an OAuth application in Linear → Settings → API with the callback URL shown here.',
    config: {
      baseUrl: 'https://api.linear.app',
      auth: { type: 'oauth2', authorizeUrl: 'https://linear.app/oauth/authorize', tokenUrl: 'https://api.linear.app/oauth/token', scopes: ['read', 'write'] },
      tools: [
        { name: 'graphql_query', description: 'Run a read-only GraphQL query against Linear.', method: 'POST', path: '/graphql', input_schema: S({ query: { type: 'string' }, variables: { type: 'object' } }, ['query']), readOnly: true },
        { name: 'graphql_mutation', description: 'Run a GraphQL mutation (creates/changes data).', method: 'POST', path: '/graphql', input_schema: S({ query: { type: 'string' }, variables: { type: 'object' } }, ['query']), readOnly: false },
      ],
    },
  },
];
