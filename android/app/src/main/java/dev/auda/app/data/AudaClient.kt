package dev.auda.app.data

import android.content.ContentResolver
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.BufferedSink
import okio.source
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String) : IOException(message)

/** REST + realtime client for one AUDA instance. */
class AudaClient(val baseUrl: String, var token: String?) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.MINUTES)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val json = "application/json".toMediaType()

    private fun req(path: String) = Request.Builder().url(baseUrl.trimEnd('/') + path).apply { token?.let { header("x-auda-token", it) } }

    private suspend fun call(r: Request): String = withContext(Dispatchers.IO) {
        http.newCall(r).execute().use { res -> body(res) }
    }

    private fun body(res: Response): String {
        val text = res.body?.string() ?: ""
        if (!res.isSuccessful) {
            val msg = runCatching { JSONObject(text).optString("error") }.getOrNull()?.takeIf { it.isNotBlank() } ?: "HTTP ${res.code}"
            throw ApiException(res.code, msg)
        }
        return text
    }

    suspend fun get(path: String): String = call(req(path).get().build())
    suspend fun post(path: String, body: JSONObject = JSONObject()): String = call(req(path).post(body.toString().toRequestBody(json)).build())
    suspend fun put(path: String, body: JSONObject): String = call(req(path).put(body.toString().toRequestBody(json)).build())
    suspend fun delete(path: String): String = call(req(path).delete().build())

    suspend fun discover(): JSONObject = JSONObject(get("/api/discover"))
    suspend fun bootstrap(): JSONObject = JSONObject(get("/api/bootstrap"))
    suspend fun agents(): List<Agent> = JSONArray(get("/api/agents")).objects().map(Parse::agent)
    suspend fun groupMessages(): List<Message> = JSONArray(get("/api/group/messages")).objects().map(Parse::message)
    suspend fun messages(conversationId: String): List<Message> = JSONArray(get("/api/conversations/$conversationId/messages")).objects().map(Parse::message)
    suspend fun taskDetail(id: String): JSONObject = JSONObject(get("/api/tasks/$id"))

    suspend fun chat(text: String, conversationId: String?): String =
        JSONObject(post("/api/chat", JSONObject().put("text", text).put("channel", "android").apply { conversationId?.let { put("conversationId", it) } })).optString("conversationId")

    suspend fun group(text: String, attachments: List<String>, mentions: List<String>) {
        post("/api/group", JSONObject().put("text", text).put("channel", "android").put("from", "the AUDA app")
            .put("attachments", JSONArray(attachments)).put("mentions", JSONArray(mentions)))
    }

    suspend fun decide(approvalId: String, approve: Boolean) {
        post("/api/approvals/$approvalId/decide", JSONObject().put("decision", if (approve) "approved" else "rejected").put("channel", "android"))
    }

    suspend fun taskAction(id: String, action: String) { post("/api/tasks/$id/$action") }
    suspend fun messageAgent(id: String, text: String) { post("/api/tasks/$id/message", JSONObject().put("text", text)) }

    suspend fun assign(title: String, goal: String, criteria: String, attachments: List<String>): String {
        val details = if (attachments.isEmpty()) goal else goal + "\n\nFiles the user attached:\n" + attachments.joinToString("\n") { "- $it" }
        return JSONObject(post("/api/tasks", JSONObject().put("title", title).put("goal", details.ifBlank { title }).apply { if (criteria.isNotBlank()) put("criteria", criteria) })).optString("id")
    }

    /** Stream a document from the phone into AUDA's inbox (folder structure preserved via [dir]). */
    suspend fun upload(resolver: ContentResolver, uri: Uri, name: String, dir: String?, onProgress: (Long) -> Unit = {}): String = withContext(Dispatchers.IO) {
        val type = (resolver.getType(uri) ?: "application/octet-stream").toMediaType()
        val body = object : RequestBody() {
            override fun contentType(): MediaType = type
            override fun writeTo(sink: BufferedSink) {
                resolver.openInputStream(uri)?.use { input ->
                    val src = input.source()
                    var total = 0L
                    while (true) {
                        val n = src.read(sink.buffer, 64 * 1024L)
                        if (n == -1L) break
                        total += n
                        sink.emitCompleteSegments()
                        onProgress(total)
                    }
                } ?: throw IOException("Can't read $name")
            }
        }
        val qs = buildString {
            append("?name=").append(enc(name)).append("&from=").append(enc("the AUDA app"))
            if (!dir.isNullOrBlank()) append("&dir=").append(enc(dir))
        }
        JSONObject(call(req("/api/files$qs").post(body).build())).optString("path")
    }

    suspend fun requestPairing(deviceName: String, platform: String): JSONObject =
        JSONObject(post("/api/pair/request", JSONObject().put("name", deviceName).put("platform", platform)))

    suspend fun pairingStatus(requestId: String, secret: String): JSONObject = JSONObject(get("/api/pair/$requestId?secret=${enc(secret)}"))

    fun openRealtime(listener: WebSocketListener): WebSocket {
        val ws = baseUrl.trimEnd('/').replaceFirst("http", "ws") + "/ws" + (token?.let { "?token=" + enc(it) } ?: "")
        return http.newWebSocket(Request.Builder().url(ws).build(), listener)
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
