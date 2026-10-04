package dev.auda.app.data

import org.json.JSONArray
import org.json.JSONObject

/** A discovered or saved AUDA instance on the network. */
data class Instance(
    val id: String,
    val name: String,
    val baseUrl: String,
    val version: String = "",
    val requiresPairing: Boolean = false,
    val presence: String = "available",
    val narration: String = "",
    val via: String = "",
    val token: String? = null,
)

data class Identity(val name: String, val userName: String?, val presence: String, val narration: String)

data class PlanStep(val title: String, val status: String)
data class Step(val idx: Int, val title: String, val state: String, val narration: String?)
data class Review(val verdict: String, val summary: String, val issues: List<String>, val round: Int)
data class ChildRef(val id: String, val title: String, val state: String)

data class Task(
    val id: String,
    val title: String,
    val goal: String?,
    val state: String,
    val playbook: String,
    val nowLine: String?,
    val currentStep: Int,
    val stepCount: Int,
    val attention: String?,
    val result: String?,
    val error: String?,
    val diagnosis: String?,
    val parentTaskId: String?,
    val depth: Int,
    val plan: List<PlanStep>,
    val steps: List<Step>,
    val verification: Review?,
    val children: List<ChildRef>,
    val criteria: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val completedAt: Long?,
    val nextEventAt: Long?,
) {
    val active get() = state !in setOf("COMPLETED", "FAILED", "CANCELLED")
    fun progressText(): String = when {
        state == "COMPLETED" -> "Finished"
        state == "SCHEDULED" -> "Scheduled"
        playbook == "agent" && plan.isNotEmpty() -> "${plan.count { it.status == "done" }} of ${plan.size} planned steps"
        playbook == "agent" -> "${steps.count { it.state == "done" }} turns so far"
        else -> "${minOf(currentStep, stepCount)} of $stepCount known steps"
    }
}

data class Approval(
    val id: String,
    val taskId: String,
    val title: String,
    val summary: String,
    val recommendation: String?,
    val impact: String?,
    val ifYes: String?,
    val ifNo: String?,
    val approveLabel: String?,
    val rejectLabel: String?,
    val evidence: List<Pair<String, String>>,
    val actions: List<String>,
    val state: String,
    val taskTitle: String?,
    val createdAt: Long,
)

data class Watcher(val description: String, val lastValue: String?)
data class Responsibility(val id: String, val title: String, val state: String, val statusLine: String?, val lastOutcome: String?, val watchers: List<Watcher>)

data class Message(
    val id: String,
    val conversationId: String,
    val role: String,
    val content: String,
    val objects: List<Pair<String, String>>,
    val createdAt: Long,
    val authorType: String,
    val authorId: String?,
    val authorName: String,
    val authorState: String?,
    val attachments: List<String>,
    val channel: String,
)

data class Agent(val id: String, val name: String, val kind: String, val state: String, val nowLine: String?)
data class ActivityItem(val id: String, val ts: Long, val kind: String, val title: String, val detail: String?)
data class Conversation(val id: String, val title: String, val channel: String, val updatedAt: Long)

// ─── parsing ──────────────────────────────────────────────────────────────────

fun JSONObject.str(k: String): String? = if (isNull(k) || !has(k)) null else optString(k)
fun JSONObject.lng(k: String): Long? = if (isNull(k) || !has(k)) null else optLong(k)
fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }

object Parse {
    fun identity(o: JSONObject) = Identity(o.optString("name", "AUDA"), o.str("userName"), o.optString("presence", "available"), o.optString("narration", ""))

    fun task(o: JSONObject) = Task(
        id = o.getString("id"), title = o.optString("title"), goal = o.str("goal"), state = o.optString("state"), playbook = o.optString("playbook"),
        nowLine = o.str("nowLine"), currentStep = o.optInt("currentStep"), stepCount = o.optInt("stepCount"), attention = o.str("attention"),
        result = o.str("result"), error = o.str("error"), diagnosis = o.str("diagnosis"), parentTaskId = o.str("parentTaskId"), depth = o.optInt("depth"),
        plan = o.optJSONArray("plan")?.objects()?.map { PlanStep(it.optString("title"), it.optString("status")) } ?: emptyList(),
        steps = o.optJSONArray("steps")?.objects()?.map { Step(it.optInt("idx"), it.optString("title"), it.optString("state"), it.str("narration")) } ?: emptyList(),
        verification = o.optJSONObject("verification")?.let { Review(it.optString("verdict"), it.optString("summary"), it.optJSONArray("issues").strings(), it.optInt("round", 1)) },
        children = o.optJSONArray("children")?.objects()?.map { ChildRef(it.optString("id"), it.optString("title"), it.optString("state")) } ?: emptyList(),
        criteria = o.str("criteria"), createdAt = o.optLong("createdAt"), updatedAt = o.optLong("updatedAt"), completedAt = o.lng("completedAt"), nextEventAt = o.lng("nextEventAt"),
    )

    fun approval(o: JSONObject) = Approval(
        id = o.getString("id"), taskId = o.optString("taskId"), title = o.optString("title"), summary = o.optString("summary"),
        recommendation = o.str("recommendation"), impact = o.str("impact"), ifYes = o.str("ifYes"), ifNo = o.str("ifNo"),
        approveLabel = o.str("approveLabel"), rejectLabel = o.str("rejectLabel"),
        evidence = o.optJSONArray("evidence")?.objects()?.map { it.optString("label") to it.optString("value") } ?: emptyList(),
        actions = o.optJSONArray("actions")?.objects()?.map { it.optString("describe") } ?: emptyList(),
        state = o.optString("state"), taskTitle = o.optJSONObject("task")?.optString("title"), createdAt = o.optLong("createdAt"),
    )

    fun responsibility(o: JSONObject) = Responsibility(
        id = o.getString("id"), title = o.optString("title"), state = o.optString("state"), statusLine = o.str("statusLine"), lastOutcome = o.str("lastOutcome"),
        watchers = o.optJSONArray("watchers")?.objects()?.map { Watcher(it.optString("description"), it.str("lastValue")) } ?: emptyList(),
    )

    fun message(o: JSONObject) = Message(
        id = o.getString("id"), conversationId = o.optString("conversationId"), role = o.optString("role"), content = o.optString("content"),
        objects = o.optJSONArray("objects")?.objects()?.map { it.optString("type") to it.optString("id") } ?: emptyList(),
        createdAt = o.optLong("createdAt"), authorType = o.optString("authorType", if (o.optString("role") == "user") "user" else "auda"),
        authorId = o.str("authorId"), authorName = o.optString("authorName", if (o.optString("role") == "user") "You" else "AUDA"),
        authorState = o.str("authorState"), attachments = o.optJSONArray("attachments").strings(), channel = o.optString("channel", "web"),
    )

    fun agent(o: JSONObject) = Agent(o.getString("id"), o.optString("name"), o.optString("kind"), o.optString("state"), o.str("nowLine"))
    fun activity(o: JSONObject) = ActivityItem(o.getString("id"), o.optLong("ts"), o.optString("kind"), o.optString("title"), o.str("detail"))
    fun conversation(o: JSONObject) = Conversation(o.getString("id"), o.optString("title"), o.optString("channel"), o.optLong("updatedAt"))
}
