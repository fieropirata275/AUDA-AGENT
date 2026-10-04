package dev.auda.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.auda.app.data.Approval
import dev.auda.app.data.Message
import dev.auda.app.data.Task
import dev.auda.app.ui.design.AudaButton
import dev.auda.app.ui.design.Chip
import dev.auda.app.ui.design.Level
import dev.auda.app.ui.design.Txt
import dev.auda.app.ui.design.Variant
import dev.auda.app.ui.design.raised
import dev.auda.app.ui.design.well
import dev.auda.app.ui.motion.Aperture
import dev.auda.app.ui.motion.Morph
import dev.auda.app.ui.theme.LocalAuda
import dev.auda.app.ui.theme.Type
import java.text.DateFormat
import java.util.Date

val TASK_SHAPE = mapOf(
    "READY" to "dots", "RUNNING" to "orbit", "WAITING_EXTERNAL" to "clock", "WAITING_USER" to "attention", "SCHEDULED" to "clock",
    "PAUSED" to "pause", "RETRYING" to "recover", "RECOVERING" to "recover", "COMPLETED" to "check", "FAILED" to "problem", "CANCELLED" to "close",
)
val TASK_LABEL = mapOf(
    "READY" to "Up next", "RUNNING" to "Working", "WAITING_EXTERNAL" to "Waiting", "WAITING_USER" to "Needs you", "SCHEDULED" to "Scheduled",
    "PAUSED" to "Paused", "RETRYING" to "Retrying", "RECOVERING" to "Recovering", "COMPLETED" to "Done", "FAILED" to "Hit a problem", "CANCELLED" to "Stopped",
)
val PRESENCE_LABEL = mapOf(
    "available" to "Available", "thinking" to "Thinking", "working" to "Working", "browsing" to "Browsing", "coding" to "At the terminal", "waiting" to "Waiting",
    "watching" to "Watching", "scheduled" to "Scheduled", "needs_you" to "Needs you", "blocked" to "Blocked", "idle" to "Resting", "recovering" to "Recovering", "listening" to "Listening",
)

@Composable
fun taskColor(state: String, attention: String?): Color {
    val c = LocalAuda.current
    return when {
        attention == "problem" -> c.problem
        state == "RUNNING" -> c.accent
        state == "WAITING_USER" || state == "RETRYING" || state == "RECOVERING" -> c.attention
        state == "COMPLETED" -> c.settled
        state == "FAILED" -> c.problem
        else -> c.ink3
    }
}

@Composable
fun TaskGlyph(state: String, attention: String? = null, size: Int = 20) {
    Morph(if (attention == "problem" && state == "WAITING_USER") "blocked" else TASK_SHAPE[state] ?: "dots", size.dp, taskColor(state, attention))
}

@Composable
fun TaskCard(t: Task, onClick: () -> Unit) {
    val c = LocalAuda.current
    val active = t.state == "RUNNING" || t.state == "RECOVERING"
    val lift by animateDpAsState(if (active) (-2).dp else 0.dp, spring(stiffness = 260f, dampingRatio = 0.8f), label = "lift")
    Row(
        Modifier.fillMaxWidth().offset(y = lift).raised(20.dp, if (active) Level.Lifted else Level.Raised).clickable(onClick = onClick).padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.size(38.dp).well(12.dp), contentAlignment = Alignment.Center) { TaskGlyph(t.state, t.attention, 22) }
        Column(Modifier.weight(1f)) {
            Txt(t.title, Type.bodyStrong, maxLines = 2)
            val line = when (t.state) { "COMPLETED" -> t.result; "FAILED" -> t.diagnosis ?: t.error; else -> t.nowLine }
            if (!line.isNullOrBlank()) Txt(line, Type.small, c.ink2, Modifier.padding(top = 2.dp), maxLines = 3)
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(taskColor(t.state, t.attention)))
                Txt(TASK_LABEL[t.state] ?: t.state, Type.label, c.ink2)
                Txt("· ${t.progressText()}", Type.label, c.ink3, maxLines = 1)
            }
            if (t.children.isNotEmpty() || t.verification != null) Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (t.children.isNotEmpty()) Chip("${t.children.count { it.state == "COMPLETED" }}/${t.children.size} subtasks")
                t.verification?.let { v -> Chip(if (v.verdict == "pass") "Verified" else if (v.verdict == "fail") "Review: issues" else "Unreviewed", if (v.verdict == "pass") "settled" else "attention") }
            }
        }
    }
}

/** The "Needs you" card: why, what AUDA recommends, what happens on yes and on no. */
@Composable
fun ApprovalCard(a: Approval, onDecide: (Boolean) -> Unit, onInspect: () -> Unit, dense: Boolean = false) {
    val c = LocalAuda.current
    var open by remember { mutableStateOf(!dense) }
    var deciding by remember { mutableStateOf<Boolean?>(null) }
    Column(Modifier.fillMaxWidth().raised(24.dp, Level.Lifted).padding(20.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.size(42.dp).clip(RoundedCornerShape(13.dp)).background(c.attentionSoft), contentAlignment = Alignment.Center) {
                Morph(if (deciding == true || a.state == "approved") "check" else if (deciding == false || a.state == "rejected") "close" else "attention", 22.dp, if (deciding == true) c.settled else c.attention)
            }
            Column(Modifier.weight(1f).clickable { open = !open }) {
                Txt(a.taskTitle ?: "A decision", Type.label, c.ink3, maxLines = 1)
                Txt(a.title, Type.display.copy(fontSize = Type.display.fontSize * 0.62f, lineHeight = Type.display.lineHeight * 0.68f))
            }
        }
        Txt(a.summary, Type.body, modifier = Modifier.padding(top = 12.dp))
        AnimatedVisibility(open) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 12.dp)) {
                a.recommendation?.let {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.accentSoft).padding(12.dp)) {
                        Txt("AUDA recommends", Type.label, c.accent); Txt(it, Type.body)
                        a.impact?.let { im -> Txt(im, Type.small, c.ink2, Modifier.padding(top = 4.dp)) }
                    }
                }
                if (a.ifYes != null || a.ifNo != null) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f).well(14.dp).padding(12.dp)) { Txt("If you approve", Type.label, c.ink3); Txt(a.ifYes ?: "AUDA goes ahead and verifies the result.", Type.small, c.ink2) }
                    Column(Modifier.weight(1f).well(14.dp).padding(12.dp)) { Txt("If you decline", Type.label, c.ink3); Txt(a.ifNo ?: "AUDA stops and looks for another way.", Type.small, c.ink2) }
                }
                if (a.evidence.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    for ((k, v) in a.evidence) Row { Txt(k, Type.small, c.ink3, Modifier.widthIn(min = 92.dp, max = 120.dp)); Txt(v, Type.small) }
                }
                if (a.actions.isNotEmpty()) Column {
                    Txt("Exactly what you’re authorising", Type.label, c.ink3)
                    for (x in a.actions) Txt("› $x", Type.small, c.ink2)
                }
            }
        }
        if (a.state == "pending") Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AudaButton(a.approveLabel ?: "Approve", { deciding = true; onDecide(true) }, variant = Variant.Primary, enabled = deciding == null, leading = { Morph(if (deciding == true) "check" else "arrowRight", 17.dp, c.accentInk) })
            AudaButton(a.rejectLabel ?: "Don’t", { deciding = false; onDecide(false) }, enabled = deciding == null)
            AudaButton("Inspect", onInspect, variant = Variant.Ghost)
        } else Txt(if (a.state == "approved") "You approved this." else if (a.state == "rejected") "You declined this." else "No longer needed.", Type.small, c.ink3, Modifier.padding(top = 12.dp))
    }
}

private val timeFmt = DateFormat.getTimeInstance(DateFormat.SHORT)

@Composable
fun MessageBubble(m: Message, tasks: Map<String, Task>, approvals: Map<String, Approval>, onTask: (String) -> Unit, onDecide: (Approval, Boolean) -> Unit) {
    val c = LocalAuda.current
    val mine = m.authorType == "user"
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        if (!mine) {
            Box(Modifier.padding(top = if (m.authorType == "agent") 18.dp else 0.dp, end = 10.dp)) {
                if (m.authorType == "agent") Box(Modifier.size(30.dp).well(10.dp), contentAlignment = Alignment.Center) { TaskGlyph(m.authorState ?: "RUNNING", size = 16) }
                else Aperture("available", 30.dp)
            }
        }
        Column(Modifier.widthIn(max = 520.dp).weight(1f, fill = false), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
            if (!mine) Txt(m.authorName, Type.label.copy(color = c.ink2), modifier = Modifier.padding(start = 4.dp, bottom = 3.dp).then(if (m.authorId != null) Modifier.clickable { onTask(m.authorId) } else Modifier))
            Box(if (mine) Modifier.well(18.dp).padding(horizontal = 15.dp, vertical = 10.dp) else Modifier.raised(18.dp).padding(horizontal = 15.dp, vertical = 10.dp)) { Txt(m.content, Type.body) }
            if (m.attachments.isNotEmpty()) Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (p in m.attachments.take(4)) Chip(p.substringAfterLast('/'))
                if (m.attachments.size > 4) Chip("+${m.attachments.size - 4}")
            }
            for ((type, id) in m.objects) {
                Spacer(Modifier.size(8.dp))
                when (type) {
                    "task" -> tasks[id]?.let { TaskCard(it) { onTask(id) } }
                    "approval" -> approvals[id]?.let { a -> ApprovalCard(a, { ok -> onDecide(a, ok) }, { onTask(a.taskId) }, dense = true) }
                }
            }
            Txt(timeFmt.format(Date(m.createdAt)) + if (m.channel == "android") "" else " · ${m.channel}", Type.label.copy(color = c.ink4), modifier = Modifier.padding(4.dp))
        }
    }
}

@Composable
fun Empty(title: String, body: String = "") {
    val c = LocalAuda.current
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(c.surface.copy(alpha = 0.5f)).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Txt(title, Type.voice.copy(fontSize = Type.voice.fontSize * 0.95f), c.ink2)
        if (body.isNotBlank()) Txt(body, Type.small, c.ink3, Modifier.padding(top = 4.dp))
    }
}
