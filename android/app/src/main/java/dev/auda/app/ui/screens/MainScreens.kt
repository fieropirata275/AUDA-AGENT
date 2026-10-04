package dev.auda.app.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.auda.app.data.Agent
import dev.auda.app.data.AudaViewModel
import dev.auda.app.data.Task
import dev.auda.app.data.Parse
import dev.auda.app.data.objects
import dev.auda.app.ui.design.AudaButton
import dev.auda.app.ui.design.Chip
import dev.auda.app.ui.design.Level
import dev.auda.app.ui.design.SectionHead
import dev.auda.app.ui.design.Segmented
import dev.auda.app.ui.design.Txt
import dev.auda.app.ui.design.Variant
import dev.auda.app.ui.design.raised
import dev.auda.app.ui.design.well
import dev.auda.app.ui.motion.Aperture
import dev.auda.app.ui.motion.Morph
import dev.auda.app.ui.theme.LocalAuda
import dev.auda.app.ui.theme.Type
import java.util.Calendar

private val TERMINAL = setOf("COMPLETED", "FAILED", "CANCELLED")
private fun greeting(): String = when (Calendar.getInstance().get(Calendar.HOUR_OF_DAY)) { in 0..4 -> "Good night"; in 5..11 -> "Good morning"; in 12..17 -> "Good afternoon"; else -> "Good evening" }

// ─── Home ────────────────────────────────────────────────────────────────────

@Composable
fun HomeScreen(vm: AudaViewModel, openTask: (String) -> Unit, go: (String) -> Unit) {
    val c = LocalAuda.current
    val ui by vm.ui.collectAsState()
    val inst by vm.current.collectAsState()
    val id = ui.identity
    val pending = ui.approvals.values.filter { it.state == "pending" }.sortedBy { it.createdAt }
    val working = ui.tasks.values.filter { it.parentTaskId == null && it.active && it.state != "SCHEDULED" && !(it.state == "WAITING_USER" && it.attention == "approval") }.sortedByDescending { it.updatedAt }
    val watching = ui.responsibilities.values.filter { it.state != "ENDED" }
    val done = ui.tasks.values.filter { it.parentTaskId == null && it.state == "COMPLETED" }.sortedByDescending { it.completedAt ?: 0 }.take(4)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 120.dp)) {
        item {
            Column(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Aperture(id?.presence ?: "available", 188.dp)
                Row(Modifier.padding(top = 12.dp).well(20.dp).padding(horizontal = 12.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(7.dp).clip(RoundedCornerShape(4.dp)).background(if (ui.connected) c.settled else c.problem))
                    Txt(PRESENCE_LABEL[id?.presence] ?: "Connecting", Type.label, c.ink2)
                }
                Txt("${greeting()}${id?.userName?.let { ", $it" } ?: ""}.", Type.display, modifier = Modifier.padding(top = 12.dp))
                Txt("“${id?.narration ?: "…"}”", Type.voice, c.ink2, Modifier.padding(top = 6.dp))
                Txt(inst?.name ?: "", Type.label, c.ink3, Modifier.padding(top = 6.dp))
                if (ui.safeMode) Txt("Safe mode: AUDA paused task execution after repeated crashes. Resume it from the web app’s Settings → Reliability.", Type.small, c.problem, Modifier.padding(top = 8.dp))
            }
        }
        item {
            Row(Modifier.fillMaxWidth().padding(top = 22.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((label, n, route) in listOf(Triple("Working", working.size, "work"), Triple("Watching", watching.size, "work"), Triple("Needs you", pending.size, "work"))) {
                    val hot = label == "Needs you" && n > 0
                    Column(Modifier.weight(1f).raised(16.dp, brush = if (hot) c.ember else null).clickable { go(route) }.padding(horizontal = 14.dp, vertical = 11.dp)) {
                        Txt("$n", Type.titleLg, if (hot) c.accentInk else c.ink)
                        Txt(label, Type.label, if (hot) c.accentInk.copy(alpha = 0.85f) else c.ink3)
                    }
                }
            }
        }
        if (pending.isNotEmpty()) {
            item { SectionHead(if (pending.size == 1) "One thing needs you" else "${pending.size} things need you") }
            items(pending, key = { it.id }) { a -> Box(Modifier.padding(bottom = 12.dp)) { ApprovalCard(a, { ok -> vm.decide(a, ok) }, { openTask(a.taskId) }) } }
        }
        item { SectionHead("Working on", working.size) }
        if (working.isEmpty()) item { Empty("Nothing in motion", "Watchers keep running. Assign work from Team or Work.") }
        items(working, key = { it.id }) { t -> Box(Modifier.padding(bottom = 10.dp)) { TaskCard(t) { openTask(t.id) } } }
        if (watching.isNotEmpty()) {
            item { SectionHead("Watching", watching.size) }
            items(watching, key = { it.id }) { r ->
                Column(Modifier.fillMaxWidth().padding(bottom = 10.dp).raised(20.dp).padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Morph(when (r.state) { "HANDLING" -> "orbit"; "NEEDS_USER" -> "attention"; "PAUSED" -> "pause"; else -> "eye" }, 20.dp, if (r.state == "HANDLING") c.accent else c.ink2)
                        Txt(r.title, Type.bodyStrong, modifier = Modifier.weight(1f), maxLines = 1)
                    }
                    r.statusLine?.let { Txt(it, Type.small, c.ink2, Modifier.padding(top = 4.dp), maxLines = 2) }
                    if (r.watchers.isNotEmpty()) Column(Modifier.padding(top = 10.dp).fillMaxWidth().well(12.dp).padding(10.dp)) {
                        for (w in r.watchers) Row { Txt(w.description, Type.small, c.ink3, Modifier.weight(1f), maxLines = 1); Txt(w.lastValue ?: "…", Type.small) }
                    }
                }
            }
        }
        if (done.isNotEmpty()) {
            item { SectionHead("Recently finished") }
            items(done, key = { "d" + it.id }) { t ->
                Row(Modifier.fillMaxWidth().clickable { openTask(t.id) }.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Morph("check", 18.dp, c.settled)
                    Column(Modifier.weight(1f)) { Txt(t.title, Type.bodyStrong, maxLines = 1); Txt(t.result ?: "", Type.small, c.ink2, maxLines = 2) }
                }
            }
        }
    }
}

// ─── Composer ────────────────────────────────────────────────────────────────

@Composable
fun Composer(placeholder: String, busy: Boolean, onSend: (String) -> Unit, modifier: Modifier = Modifier, leading: (@Composable () -> Unit)? = null, canSendEmpty: Boolean = false, onTextChange: (String) -> Unit = {}, text: String? = null) {
    val c = LocalAuda.current
    var local by remember { mutableStateOf("") }
    val value = text ?: local
    Row(modifier.fillMaxWidth().well(22.dp).padding(start = 8.dp, end = 6.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        leading?.invoke()
        BasicTextField(value, { local = it; onTextChange(it) }, textStyle = Type.body.copy(color = c.ink, fontSize = 16.sp), cursorBrush = SolidColor(c.accent), maxLines = 6,
            modifier = Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 11.dp),
            decorationBox = { inner -> Box { if (value.isEmpty()) Txt(placeholder, Type.body.copy(fontSize = 16.sp), c.ink3, maxLines = 1); inner() } })
        val enabled = !busy && (value.isNotBlank() || canSendEmpty)
        Box(Modifier.size(44.dp).raised(15.dp, brush = if (enabled) c.ember else c.metal).clickable(enabled = enabled) { onSend(value); local = ""; onTextChange("") }, contentAlignment = Alignment.Center) {
            Morph(if (busy) "wave" else "arrowUp", 20.dp, if (enabled) c.accentInk else c.ink4)
        }
    }
}

// ─── Chat (1:1 with AUDA) ────────────────────────────────────────────────────

@Composable
fun ChatScreen(vm: AudaViewModel, openTask: (String) -> Unit) {
    val c = LocalAuda.current
    val ui by vm.ui.collectAsState()
    val list = rememberLazyListState()
    LaunchedEffect(ui.chat.size) { if (ui.chat.isNotEmpty()) list.animateScrollToItem(ui.chat.size - 1) }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Txt("Chat", Type.titleLg, modifier = Modifier.weight(1f))
            AudaButton("New", { vm.newChat() }, variant = Variant.Ghost, small = true, leading = { Morph("plus", 15.dp, c.ink2) })
        }
        LazyColumn(Modifier.weight(1f), state = list, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
            if (ui.chat.isEmpty()) item {
                Column(Modifier.fillMaxWidth().padding(top = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Aperture(ui.identity?.presence ?: "available", 110.dp)
                    Txt("What should I take care of?", Type.display.copy(fontSize = 28.sp), modifier = Modifier.padding(top = 16.dp))
                    Txt("Ongoing things become responsibilities; rules become policy. I keep going after you close the app.", Type.small, c.ink2, Modifier.padding(top = 6.dp))
                    Row(Modifier.padding(top = 14.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (s in listOf("What are you doing?", "Keep the server healthy", "Remind me tomorrow at 9 to call the supplier", "Never spend money")) Chip(s, onClick = { vm.sendChat(s) })
                    }
                }
            }
            items(ui.chat, key = { it.id }) { m -> MessageBubble(m, ui.tasks, ui.approvals, openTask) { a, ok -> vm.decide(a, ok) } }
        }
        Composer("Tell AUDA what to handle…", false, { vm.sendChat(it) }, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 96.dp, top = 6.dp))
    }
}

// ─── Team (group chat with every agent) ──────────────────────────────────────

@Composable
fun TeamScreen(vm: AudaViewModel, openTask: (String) -> Unit) {
    val c = LocalAuda.current
    val ui by vm.ui.collectAsState()
    val uploads by vm.uploads.collectAsState()
    val list = rememberLazyListState()
    val mentions = remember { mutableStateListOf<Agent>() }
    val files = remember { mutableStateListOf<Uri>() }
    var folder by remember { mutableStateOf<Uri?>(null) }
    var text by remember { mutableStateOf("") }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { files.addAll(it) }
    val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { folder = it }
    LaunchedEffect(ui.group.size) { if (ui.group.isNotEmpty()) list.animateScrollToItem(ui.group.size - 1) }
    val query = Regex("@([\\w-]*)$").find(text)?.groupValues?.get(1)
    val suggestions = if (query != null) ui.agents.filter { it.name.contains(query, ignoreCase = true) }.take(5) else emptyList()
    val live = ui.agents.filter { it.kind != "coordinator" && it.state !in TERMINAL }

    Column(Modifier.fillMaxSize().imePadding()) {
        Column(Modifier.padding(horizontal = 18.dp, vertical = 10.dp)) {
            Txt("Team", Type.titleLg)
            Txt(if (live.isEmpty()) "No agents working. Type /task to assign work." else "${live.size} agent${if (live.size > 1) "s" else ""} working · tap to mention", Type.small, c.ink3)
        }
        if (live.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (a in live) Row(Modifier.raised(14.dp).clickable { if (mentions.none { it.id == a.id }) mentions.add(a) }.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TaskGlyph(a.state, size = 16)
                Column(Modifier.width(150.dp)) { Txt(a.name.substringAfter("· "), Type.label, maxLines = 1); Txt(a.nowLine ?: "", Type.label, c.ink3, maxLines = 1) }
            }
        }
        LazyColumn(Modifier.weight(1f), state = list, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
            if (ui.group.isEmpty()) item { Empty("Your team", "Everyone working for you, in one room. /task assigns work, @ talks to an agent mid-task, and you can attach files or folders.") }
            items(ui.group, key = { it.id }) { m -> MessageBubble(m, ui.tasks, ui.approvals, openTask) { a, ok -> vm.decide(a, ok) } }
        }
        if (suggestions.isNotEmpty()) Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().raised(16.dp, Level.Floating).padding(6.dp)) {
            for (a in suggestions) Row(Modifier.fillMaxWidth().clickable { text = text.replace(Regex("@[\\w-]*$"), ""); if (mentions.none { it.id == a.id }) mentions.add(a) }.padding(10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (a.kind == "coordinator") Aperture("available", 18.dp) else TaskGlyph(a.state, size = 14)
                Txt(a.name, Type.small, maxLines = 1)
            }
        }
        if (mentions.isNotEmpty() || files.isNotEmpty() || folder != null || uploads.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (m in mentions.toList()) Chip("@" + m.name.substringAfter("· ") + " ×", "accent") { mentions.remove(m) }
            for (f in files.toList()) Chip((f.lastPathSegment?.substringAfterLast('/') ?: "file") + " ×") { files.remove(f) }
            folder?.let { Chip("Folder: " + (it.lastPathSegment?.substringAfterLast(':') ?: "") + " ×") { folder = null } }
            for (u in uploads) Chip("${u.name} ${if (u.done) "✓" else u.error?.let { "✕" } ?: "${u.sent / 1024} KB"}", if (u.error != null) "problem" else "")
        }
        Composer(
            "Message the team · /task · @agent", uploads.isNotEmpty(),
            onSend = { msg -> vm.sendGroup(msg, mentions.map { it.id }, files.toList(), folder); mentions.clear(); files.clear(); folder = null; text = "" },
            modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 96.dp, top = 4.dp),
            leading = {
                Row(Modifier.padding(bottom = 6.dp)) {
                    Box(Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).clickable { pickFiles.launch(arrayOf("*/*")) }, contentAlignment = Alignment.Center) { Morph("attach", 18.dp, c.ink2) }
                    Box(Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).clickable { pickFolder.launch(null) }, contentAlignment = Alignment.Center) { Morph("folder", 18.dp, c.ink2) }
                }
            },
            canSendEmpty = files.isNotEmpty() || folder != null,
            onTextChange = { text = it }, text = text,
        )
    }
}

// ─── Work ────────────────────────────────────────────────────────────────────

@Composable
fun WorkScreen(vm: AudaViewModel, openTask: (String) -> Unit, assign: () -> Unit) {
    val c = LocalAuda.current
    val ui by vm.ui.collectAsState()
    var view by remember { mutableStateOf("progress") }
    val top = ui.tasks.values.filter { it.parentTaskId == null }
    val pending = ui.approvals.values.filter { it.state == "pending" }
    val lists = mapOf(
        "needs" to top.filter { it.state == "WAITING_USER" || (it.state == "FAILED" && (System.currentTimeMillis() - (it.completedAt ?: 0)) < 86_400_000) },
        "progress" to top.filter { it.active && it.state != "SCHEDULED" }.sortedByDescending { it.updatedAt },
        "scheduled" to top.filter { it.state == "SCHEDULED" }.sortedBy { it.nextEventAt ?: 0 },
        "done" to top.filter { it.state in TERMINAL }.sortedByDescending { it.completedAt ?: 0 },
    )
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Txt("Work", Type.titleLg, modifier = Modifier.weight(1f))
            AudaButton("Assign", assign, variant = Variant.Primary, small = true, leading = { Morph("plus", 15.dp, c.accentInk) })
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Segmented(listOf("needs" to "Needs you ${pending.size + (lists["needs"]?.count { it.attention == "problem" } ?: 0)}".trim(), "progress" to "In progress", "scheduled" to "Scheduled", "done" to "Completed"), view, { view = it })
        }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 120.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (view == "needs") items(pending, key = { it.id }) { a -> ApprovalCard(a, { ok -> vm.decide(a, ok) }, { openTask(a.taskId) }) }
            val shown = (lists[view] ?: emptyList()).let { if (view == "needs") it.filter { t -> t.attention != "approval" } else it }
            items(shown, key = { it.id }) { t -> TaskCard(t) { openTask(t.id) } }
            if (shown.isEmpty() && !(view == "needs" && pending.isNotEmpty())) item { Empty(when (view) { "needs" -> "Nothing needs you"; "progress" -> "Nothing in motion"; "scheduled" -> "Nothing scheduled"; else -> "Nothing finished yet" }) }
        }
    }
}

// ─── Task detail ─────────────────────────────────────────────────────────────

@Composable
fun TaskScreen(vm: AudaViewModel, id: String, back: () -> Unit, openTask: (String) -> Unit) {
    val c = LocalAuda.current
    val ui by vm.ui.collectAsState()
    val live = ui.tasks[id]
    val detail by produceState<Pair<Task?, List<dev.auda.app.data.ActivityItem>>>(null to emptyList(), id, live?.updatedAt) {
        val d = vm.taskDetail(id)
        value = (d?.let { Parse.task(it) }) to (d?.optJSONArray("activity")?.objects()?.map(Parse::activity)?.reversed() ?: emptyList())
    }
    val t = live ?: detail.first
    var note by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().background(c.bg).imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).clickable(onClick = back), contentAlignment = Alignment.Center) { Morph("back", 22.dp, c.ink) }
            Txt(TASK_LABEL[t?.state] ?: "", Type.label, c.ink3, Modifier.weight(1f))
        }
        if (t == null) { Empty("Loading…"); return@Column }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(48.dp).well(15.dp), contentAlignment = Alignment.Center) { TaskGlyph(t.state, t.attention, 26) }
                    Column(Modifier.weight(1f)) { Txt(t.title, Type.title); Txt(t.progressText(), Type.small, c.ink3) }
                }
            }
            if (t.active && !t.nowLine.isNullOrBlank()) item { Txt(t.nowLine, Type.voice, c.ink2) }
            if (t.state == "COMPLETED" && t.result != null) item { Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.settledSoft).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) { Morph("check", 18.dp, c.settled); Txt(t.result, Type.body) } }
            if (t.state == "FAILED" || t.attention == "problem") item {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.problemSoft).padding(14.dp)) {
                    Txt("AUDA hit a problem", Type.bodyStrong); Txt(t.diagnosis ?: t.error ?: "", Type.small, c.ink2, Modifier.padding(top = 4.dp))
                    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { AudaButton("Try again", { vm.taskAction(id, "resume") }, small = true, variant = Variant.Primary); AudaButton("Stop", { vm.taskAction(id, "cancel") }, small = true, variant = Variant.Ghost) }
                }
            }
            val pending = ui.approvals.values.filter { it.taskId == id && it.state == "pending" }
            items(pending, key = { it.id }) { a -> ApprovalCard(a, { ok -> vm.decide(a, ok) }, {}) }
            t.verification?.let { v -> item {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(if (v.verdict == "pass") c.settledSoft else c.attentionSoft).padding(12.dp)) {
                    Txt(if (v.verdict == "pass") "Independently reviewed — meets the criteria" else if (v.verdict == "fail") "Review found issues" else "Not reviewed", Type.bodyStrong)
                    Txt(v.summary + if (v.round > 1) " · round ${v.round}" else "", Type.small, c.ink2)
                    for (i in v.issues) Txt("• $i", Type.small, c.ink2)
                }
            } }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (!t.goal.isNullOrBlank() && t.goal != t.title) { Txt("Goal", Type.label, c.ink3); Txt(t.goal, Type.small) }
                    t.criteria?.let { Txt("Done when", Type.label, c.ink3, Modifier.padding(top = 6.dp)); Txt(it, Type.small) }
                    t.parentTaskId?.let { pid -> Txt("Part of “${ui.tasks[pid]?.title ?: "a larger task"}”", Type.small, c.accent, Modifier.padding(top = 6.dp).clickable { openTask(pid) }) }
                }
            }
            val planned = if (t.playbook == "agent") t.plan.map { it.title to it.status } else t.steps.map { it.title to it.state }
            if (planned.isNotEmpty()) {
                item { Txt("Plan", Type.label, c.ink3) }
                items(planned) { (title, st) ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Morph(when (st) { "done" -> "check"; "doing", "running" -> "orbit"; "waiting" -> "attention"; "failed" -> "problem"; "skipped" -> "close"; else -> "rest" }, 16.dp,
                            when (st) { "done" -> c.settled; "doing", "running" -> c.accent; "waiting" -> c.attention; "failed" -> c.problem; else -> c.ink4 })
                        Txt(title, Type.body, if (st == "pending") c.ink3 else c.ink)
                    }
                }
            }
            if (t.children.isNotEmpty()) {
                item { Txt("Sub-agents", Type.label, c.ink3) }
                items(t.children, key = { it.id }) { ch -> ui.tasks[ch.id]?.let { TaskCard(it) { openTask(ch.id) } } }
            }
            if (detail.second.isNotEmpty()) {
                item { Txt("Timeline", Type.label, c.ink3, Modifier.padding(top = 6.dp)) }
                items(detail.second.take(60), key = { it.id }) { a ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.padding(top = 4.dp).size(8.dp).clip(RoundedCornerShape(4.dp)).background(when (a.kind) { "complete" -> c.settled; "problem" -> c.problem; "approval", "recover" -> c.attention; "act" -> c.accent; else -> c.ink4 }))
                        Column { Txt(a.title, Type.small); a.detail?.let { Txt(it, Type.label, c.ink3, maxLines = 4) } }
                    }
                }
            }
            if (t.active) item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (t.state == "PAUSED") AudaButton("Resume", { vm.taskAction(id, "resume") }, small = true) else AudaButton("Pause", { vm.taskAction(id, "pause") }, small = true)
                    AudaButton("Stop task", { vm.taskAction(id, "cancel") }, small = true, variant = Variant.Danger)
                }
            }
        }
        if (t.active && t.playbook == "agent") Composer("Message this agent…", false, { vm.messageAgent(id, it); note = "" }, Modifier.padding(12.dp), onTextChange = { note = it }, text = note)
    }
}

// ─── Assign work ─────────────────────────────────────────────────────────────

@Composable
fun AssignScreen(vm: AudaViewModel, back: () -> Unit, opened: (String) -> Unit) {
    val c = LocalAuda.current
    val ui by vm.ui.collectAsState()
    val uploads by vm.uploads.collectAsState()
    var title by remember { mutableStateOf("") }
    var goal by remember { mutableStateOf("") }
    var criteria by remember { mutableStateOf("") }
    val files = remember { mutableStateListOf<Uri>() }
    var folder by remember { mutableStateOf<Uri?>(null) }
    var busy by remember { mutableStateOf(false) }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { files.addAll(it) }
    val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { folder = it }
    @Composable fun field(label: String, hint: String, value: String, set: (String) -> Unit, lines: Int) {
        Txt(label, Type.label, c.ink2, Modifier.padding(top = 14.dp, bottom = 6.dp))
        BasicTextField(value, set, textStyle = Type.body.copy(color = c.ink), cursorBrush = SolidColor(c.accent), minLines = lines,
            modifier = Modifier.fillMaxWidth().well(14.dp).padding(14.dp),
            decorationBox = { inner -> Box { if (value.isEmpty()) Txt(hint, Type.body, c.ink3); inner() } })
    }
    Column(Modifier.fillMaxSize().background(c.bg).imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).clickable(onClick = back), contentAlignment = Alignment.Center) { Morph("close", 20.dp, c.ink) }
            Txt("Assign work", Type.title, modifier = Modifier.weight(1f))
        }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 18.dp)) {
            item {
                if (!ui.modelConnected) Txt("No reasoning model is connected on this AUDA, so open-ended work will wait until one is (Claude or LM Studio, in Connections).", Type.small, c.problem, Modifier.clip(RoundedCornerShape(12.dp)).background(c.problemSoft).padding(12.dp))
                field("What should AUDA do?", "Compare the supplier quotes in the folder and recommend one", title, { title = it }, 1)
                field("Details", "Context, constraints, where things are (optional)", goal, { goal = it }, 4)
                field("Done when", "A comparison table is saved and one option is recommended with reasons", criteria, { criteria = it }, 3)
                Txt("Files", Type.label, c.ink2, Modifier.padding(top = 14.dp, bottom = 6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AudaButton("Add files", { pickFiles.launch(arrayOf("*/*")) }, small = true, leading = { Morph("attach", 15.dp, c.ink2) })
                    AudaButton("Add a folder", { pickFolder.launch(null) }, small = true, leading = { Morph("folder", 15.dp, c.ink2) })
                }
                Row(Modifier.padding(top = 8.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (f in files.toList()) Chip((f.lastPathSegment?.substringAfterLast('/') ?: "file") + " ×") { files.remove(f) }
                    folder?.let { Chip("Folder ×") { folder = null } }
                    for (u in uploads) Chip("${u.name} ${if (u.done) "✓" else "${u.sent / 1024} KB"}")
                }
                Txt("AUDA plans the work, splits independent parts across parallel sub-agents, asks only for real decisions, and has the result independently reviewed against “done when” before calling it finished.", Type.small, c.ink3, Modifier.padding(top = 16.dp))
                Spacer(Modifier.height(16.dp))
                AudaButton(if (busy) "Uploading…" else "Assign", { busy = true; vm.assign(title, goal, criteria, files.toList(), folder) { id -> busy = false; opened(id) } }, Modifier.fillMaxWidth(), variant = Variant.Primary, enabled = title.isNotBlank() && !busy, leading = { Morph(if (busy) "wave" else "arrowRight", 18.dp, c.accentInk) })
                Spacer(Modifier.heightIn(min = 40.dp))
            }
        }
    }
}
