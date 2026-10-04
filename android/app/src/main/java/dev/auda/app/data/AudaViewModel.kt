package dev.auda.app.data

import android.app.Application
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

/** Saved instances and their pairing tokens. */
class InstanceStore(context: Context) {
    private val prefs = context.getSharedPreferences("auda.instances", Context.MODE_PRIVATE)
    fun all(): List<Instance> = runCatching {
        JSONArray(prefs.getString("list", "[]")).objects().map {
            Instance(it.getString("id"), it.optString("name"), it.optString("baseUrl"), it.optString("version"), it.optBoolean("requiresPairing"), token = it.str("token"))
        }
    }.getOrDefault(emptyList())
    fun save(i: Instance) {
        val list = all().filterNot { it.id == i.id } + i
        prefs.edit().putString("list", JSONArray(list.map { JSONObject().put("id", it.id).put("name", it.name).put("baseUrl", it.baseUrl).put("version", it.version).put("requiresPairing", it.requiresPairing).put("token", it.token) }).toString()).apply()
    }
    fun forget(id: String) { prefs.edit().putString("list", JSONArray(all().filterNot { it.id == id }.map { JSONObject().put("id", it.id).put("name", it.name).put("baseUrl", it.baseUrl).put("token", it.token) }).toString()).apply() }
    var lastId: String?
        get() = prefs.getString("last", null)
        set(v) { prefs.edit().putString("last", v).apply() }
}

data class UiState(
    val connected: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val identity: Identity? = null,
    val tasks: Map<String, Task> = emptyMap(),
    val approvals: Map<String, Approval> = emptyMap(),
    val responsibilities: Map<String, Responsibility> = emptyMap(),
    val group: List<Message> = emptyList(),
    val chat: List<Message> = emptyList(),
    val chatId: String? = null,
    val agents: List<Agent> = emptyList(),
    val activity: List<ActivityItem> = emptyList(),
    val modelConnected: Boolean = false,
    val safeMode: Boolean = false,
)

data class PairingState(val instance: Instance, val code: String? = null, val status: String = "requesting", val error: String? = null)
data class Upload(val name: String, val sent: Long, val done: Boolean = false, val path: String? = null, val error: String? = null)

class AudaViewModel(app: Application) : AndroidViewModel(app) {
    private val store = InstanceStore(app)
    private val discovery = Discovery(app)

    private val _saved = MutableStateFlow(store.all())
    val saved: StateFlow<List<Instance>> = _saved.asStateFlow()
    private val _found = MutableStateFlow<List<Instance>>(emptyList())
    val found: StateFlow<List<Instance>> = _found.asStateFlow()
    private val _scanning = MutableStateFlow<String?>(null)
    val scanning: StateFlow<String?> = _scanning.asStateFlow()
    private val _current = MutableStateFlow<Instance?>(null)
    val current: StateFlow<Instance?> = _current.asStateFlow()
    private val _pairing = MutableStateFlow<PairingState?>(null)
    val pairing: StateFlow<PairingState?> = _pairing.asStateFlow()
    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()
    private val _uploads = MutableStateFlow<List<Upload>>(emptyList())
    val uploads: StateFlow<List<Upload>> = _uploads.asStateFlow()

    private var client: AudaClient? = null
    private var socket: WebSocket? = null
    private var reconnect: Job? = null
    private var scanJob: Job? = null

    init {
        // Reopen the last instance straight away; discovery runs alongside.
        store.lastId?.let { id -> store.all().firstOrNull { it.id == id }?.let { open(it) } }
        scan()
    }

    // ─── discovery & pairing ──────────────────────────────────────────────────

    fun scan() {
        if (scanJob?.isActive == true) return
        scanJob = viewModelScope.launch {
            _found.value = emptyList()
            discovery.scan(onFound = { inst ->
                _found.update { cur -> (cur.filterNot { it.id == inst.id } + inst).sortedBy { it.name } }
                // Keep saved instances' addresses fresh (DHCP changes, new networks).
                store.all().firstOrNull { it.id == inst.id && it.baseUrl != inst.baseUrl }?.let { store.save(it.copy(baseUrl = inst.baseUrl)); _saved.value = store.all() }
            }, onPhase = { _scanning.value = it })
            _scanning.value = null
        }
    }

    fun addManual(url: String) = viewModelScope.launch {
        val base = if (url.startsWith("http")) url.trimEnd('/') else "http://${url.trim().trimEnd('/')}" + if (url.contains(':')) "" else ":4610"
        val inst = discovery.confirm(base, "manual")
        if (inst == null) _ui.update { it.copy(error = "No AUDA answered at $base") } else _found.update { cur -> cur.filterNot { it.id == inst.id } + inst }
    }

    /** Choose an instance: open directly if we hold a token or it doesn't need one, otherwise pair. */
    fun choose(inst: Instance) {
        val saved = store.all().firstOrNull { it.id == inst.id }
        val withToken = inst.copy(token = saved?.token)
        if (withToken.token != null || !inst.requiresPairing) open(withToken) else pair(inst)
    }

    fun pair(inst: Instance) = viewModelScope.launch {
        _pairing.value = PairingState(inst)
        val c = AudaClient(inst.baseUrl, null)
        try {
            val r = c.requestPairing(deviceName(), "Android ${Build.VERSION.RELEASE}")
            _pairing.value = PairingState(inst, r.optString("code"), "waiting")
            val id = r.getString("requestId"); val secret = r.getString("secret")
            while (_pairing.value?.status == "waiting") {
                delay(1500)
                val s = c.pairingStatus(id, secret)
                when (s.optString("state")) {
                    "approved" -> { val paired = inst.copy(token = s.getString("token")); store.save(paired); _saved.value = store.all(); _pairing.value = null; open(paired) }
                    "rejected" -> _pairing.value = _pairing.value?.copy(status = "rejected")
                    "expired" -> _pairing.value = _pairing.value?.copy(status = "expired")
                }
            }
        } catch (e: Exception) {
            _pairing.value = _pairing.value?.copy(status = "error", error = e.message)
        }
    }
    fun cancelPairing() { _pairing.value = null }

    fun forget(inst: Instance) { store.forget(inst.id); _saved.value = store.all(); if (_current.value?.id == inst.id) leave() }

    fun leave() {
        socket?.close(1000, null); socket = null; reconnect?.cancel(); client = null
        _current.value = null; _ui.value = UiState(); store.lastId = null
    }

    private fun deviceName() = (Build.MODEL ?: "Android").let { if (it.startsWith(Build.MANUFACTURER ?: "", ignoreCase = true)) it else "${Build.MANUFACTURER} $it" }

    // ─── connection ──────────────────────────────────────────────────────────

    fun open(inst: Instance) {
        socket?.close(1000, null)
        client = AudaClient(inst.baseUrl, inst.token)
        _current.value = inst
        store.lastId = inst.id
        if (store.all().none { it.id == inst.id }) { store.save(inst); _saved.value = store.all() }
        _ui.value = UiState(loading = true)
        refresh()
        connectSocket()
    }

    fun refresh() = viewModelScope.launch {
        val c = client ?: return@launch
        try {
            val b = c.bootstrap()
            val group = runCatching { c.groupMessages() }.getOrDefault(emptyList())
            val agents = runCatching { c.agents() }.getOrDefault(emptyList())
            val convs = b.optJSONArray("conversations")?.objects()?.map(Parse::conversation)?.filter { it.channel != "group" } ?: emptyList()
            val chatId = _ui.value.chatId ?: convs.firstOrNull()?.id
            val chat = chatId?.let { runCatching { c.messages(it) }.getOrNull() } ?: emptyList()
            _ui.update {
                it.copy(
                    loading = false, error = null,
                    identity = b.optJSONObject("identity")?.let(Parse::identity),
                    tasks = b.optJSONArray("tasks")?.objects()?.map(Parse::task)?.associateBy { t -> t.id } ?: emptyMap(),
                    approvals = b.optJSONArray("approvals")?.objects()?.map(Parse::approval)?.associateBy { a -> a.id } ?: emptyMap(),
                    responsibilities = b.optJSONArray("responsibilities")?.objects()?.map(Parse::responsibility)?.associateBy { r -> r.id } ?: emptyMap(),
                    activity = b.optJSONArray("activity")?.objects()?.map(Parse::activity) ?: emptyList(),
                    group = group, chat = chat, chatId = chatId, agents = agents,
                    modelConnected = b.optJSONObject("settings")?.optJSONObject("models")?.optBoolean("anthropicConnected") == true || b.optJSONObject("settings")?.optJSONObject("models")?.optJSONObject("local") != null,
                    safeMode = b.optBoolean("safeMode"),
                )
            }
        } catch (e: ApiException) {
            if (e.status == 401) { _current.value?.let { inst -> store.save(inst.copy(token = null)); _ui.update { it.copy(loading = false, error = "This app isn’t paired with ${inst.name} any more.") }; pair(inst.copy(token = null, requiresPairing = true)) } }
            else _ui.update { it.copy(loading = false, error = e.message) }
        } catch (e: Exception) {
            _ui.update { it.copy(loading = false, error = "Can’t reach AUDA: ${e.message}") }
        }
    }

    private fun connectSocket() {
        val c = client ?: return
        socket = c.openRealtime(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { _ui.update { it.copy(connected = true) } }
            override fun onMessage(webSocket: WebSocket, text: String) { runCatching { apply(JSONObject(text)) } }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { dropped(webSocket) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { dropped(webSocket) }
        })
    }

    private fun dropped(ws: WebSocket) {
        if (ws !== socket) return
        _ui.update { it.copy(connected = false) }
        reconnect?.cancel()
        reconnect = viewModelScope.launch {
            var wait = 1000L
            while (client != null && !_ui.value.connected) {
                delay(wait); wait = (wait * 2).coerceAtMost(15_000)
                connectSocket(); delay(1500)
                if (_ui.value.connected) refresh() // catch up on anything missed
            }
        }
    }

    /** Apply realtime entity upserts — the same protocol the web UI uses. */
    private fun apply(m: JSONObject) {
        if (m.optString("type") != "batch") return
        var agentsDirty = false
        _ui.update { s0 ->
            var s = s0
            for (it in m.getJSONArray("items").objects()) {
                val entity = it.optString("entity"); val id = it.optString("id"); val remove = it.optString("type") == "remove"
                val data = it.optJSONObject("data")
                when (entity) {
                    "identity" -> data?.let { d -> s = s.copy(identity = Parse.identity(d)) }
                    "task" -> { s = s.copy(tasks = if (remove || data == null) s.tasks - id else s.tasks + (id to Parse.task(data))); agentsDirty = true }
                    "approval" -> s = s.copy(approvals = if (remove || data == null) s.approvals - id else s.approvals + (id to Parse.approval(data)))
                    "responsibility" -> s = s.copy(responsibilities = if (remove || data == null) s.responsibilities - id else s.responsibilities + (id to Parse.responsibility(data)))
                    "activity" -> data?.let { d -> s = s.copy(activity = (listOf(Parse.activity(d)) + s.activity.filterNot { a -> a.id == id }).take(200)) }
                    "message" -> data?.let { d ->
                        val msg = Parse.message(d)
                        if (msg.conversationId == "group") s = s.copy(group = (s.group.filterNot { x -> x.id == msg.id } + msg).sortedBy { x -> x.createdAt })
                        else if (msg.conversationId == s.chatId) s = s.copy(chat = (s.chat.filterNot { x -> x.id == msg.id } + msg).sortedBy { x -> x.createdAt })
                    }
                }
            }
            s
        }
        if (agentsDirty) viewModelScope.launch { client?.let { c -> runCatching { c.agents() }.onSuccess { a -> _ui.update { it.copy(agents = a) } } } }
    }

    // ─── actions ─────────────────────────────────────────────────────────────

    private fun act(block: suspend (AudaClient) -> Unit) = viewModelScope.launch {
        val c = client ?: return@launch
        try { block(c) } catch (e: Exception) { _ui.update { it.copy(error = e.message) } }
    }
    fun clearError() = _ui.update { it.copy(error = null) }

    fun decide(a: Approval, approve: Boolean) = act { it.decide(a.id, approve) }
    fun taskAction(id: String, action: String) = act { it.taskAction(id, action) }
    fun messageAgent(id: String, text: String) = act { it.messageAgent(id, text) }

    fun sendChat(text: String) = act { c ->
        val id = c.chat(text, _ui.value.chatId)
        if (id != _ui.value.chatId) { _ui.update { it.copy(chatId = id) }; val msgs = c.messages(id); _ui.update { it.copy(chat = msgs) } }
    }
    fun newChat() = _ui.update { it.copy(chatId = null, chat = emptyList()) }

    suspend fun taskDetail(id: String): JSONObject? = client?.let { runCatching { it.taskDetail(id) }.getOrNull() }

    /** Upload documents (and whole folders) then post to the team chat. */
    fun sendGroup(text: String, mentions: List<String>, files: List<Uri>, folder: Uri?) = act { c ->
        val paths = uploadAll(c, files, folder)
        c.group(text, paths, mentions)
    }

    fun assign(title: String, goal: String, criteria: String, files: List<Uri>, folder: Uri?, done: (String) -> Unit) = act { c ->
        val paths = uploadAll(c, files, folder)
        val id = c.assign(title, goal, criteria, paths)
        done(id)
    }

    private suspend fun uploadAll(c: AudaClient, files: List<Uri>, folder: Uri?): List<String> {
        val resolver = getApplication<Application>().contentResolver
        val items = files.map { Triple(it, displayName(it), null as String?) } + (folder?.let { walkTree(it) } ?: emptyList())
        val paths = mutableListOf<String>()
        _uploads.value = items.map { Upload(it.second, 0) }
        items.forEachIndexed { i, (uri, name, dir) ->
            try {
                val p = c.upload(resolver, uri, name, dir) { sent -> _uploads.update { l -> l.mapIndexed { k, u -> if (k == i) u.copy(sent = sent) else u } } }
                paths += p
                _uploads.update { l -> l.mapIndexed { k, u -> if (k == i) u.copy(done = true, path = p) else u } }
            } catch (e: Exception) {
                _uploads.update { l -> l.mapIndexed { k, u -> if (k == i) u.copy(error = e.message) else u } }
                throw e
            }
        }
        // Folders are passed as their top-level directory so the agent sees the structure.
        val folderRoot = items.mapNotNull { it.third?.substringBefore('/') }.distinct()
        _uploads.value = emptyList()
        return if (folderRoot.isNotEmpty()) paths.filterNot { p -> folderRoot.any { p.contains("/$it/") } } + folderRoot.map { root -> paths.first { it.contains("/$root/") }.substringBefore("/$root/") + "/$root" } else paths
    }

    private fun displayName(uri: Uri): String {
        val r = getApplication<Application>().contentResolver
        r.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) return c.getString(0) }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "file"
    }

    /** Recursively list a folder picked with OpenDocumentTree, keeping relative paths. */
    private fun walkTree(tree: Uri): List<Triple<Uri, String, String?>> {
        val r = getApplication<Application>().contentResolver
        val out = mutableListOf<Triple<Uri, String, String?>>()
        fun walk(docId: String, rel: String, depth: Int) {
            if (depth > 12 || out.size > 2000) return
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
            r.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0); val name = c.getString(1); val mime = c.getString(2)
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) walk(id, "$rel/$name", depth + 1)
                    else out += Triple(DocumentsContract.buildDocumentUriUsingTree(tree, id), name, rel.trimStart('/'))
                }
            }
        }
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rootName = r.query(DocumentsContract.buildDocumentUriUsingTree(tree, rootId), arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "folder"
        walk(rootId, rootName, 0)
        return out
    }

    override fun onCleared() { socket?.close(1000, null) }
}
