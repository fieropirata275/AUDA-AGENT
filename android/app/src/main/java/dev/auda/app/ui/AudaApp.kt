package dev.auda.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.auda.app.data.AudaViewModel
import dev.auda.app.ui.design.Level
import dev.auda.app.ui.design.Txt
import dev.auda.app.ui.design.raised
import dev.auda.app.ui.motion.Aperture
import dev.auda.app.ui.motion.Morph
import dev.auda.app.ui.screens.AssignScreen
import dev.auda.app.ui.screens.ChatScreen
import dev.auda.app.ui.screens.HomeScreen
import dev.auda.app.ui.screens.InstancesScreen
import dev.auda.app.ui.screens.TaskScreen
import dev.auda.app.ui.screens.TeamScreen
import dev.auda.app.ui.screens.WorkScreen
import dev.auda.app.ui.theme.LocalAuda
import dev.auda.app.ui.theme.Type

private val TABS = listOf("home" to "Home", "chat" to "Chat", "team" to "Team", "work" to "Work")

@Composable
fun AudaApp(vm: AudaViewModel = viewModel()) {
    val c = LocalAuda.current
    val current by vm.current.collectAsState()
    val ui by vm.ui.collectAsState()
    var tab by rememberSaveable { mutableStateOf("home") }
    var taskId by rememberSaveable { mutableStateOf<String?>(null) }
    var assigning by rememberSaveable { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(c.bg)) {
        if (current == null) { InstancesScreen(vm); return@Box }
        BackHandler(enabled = taskId != null || assigning || tab != "home") { when { taskId != null -> taskId = null; assigning -> assigning = false; else -> tab = "home" } }
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.weight(1f).clip(CircleShape).clickable { vm.leave() }.padding(4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Aperture(ui.identity?.presence ?: "idle", 28.dp)
                    Column {
                        Txt(current?.name ?: "AUDA", Type.label, maxLines = 1)
                        Txt(if (ui.connected) "Live · tap to switch" else "Reconnecting…", Type.label, if (ui.connected) c.ink3 else c.problem, maxLines = 1)
                    }
                }
            }
            ui.error?.let { e -> Txt(e, Type.small, c.problem, Modifier.fillMaxWidth().clickable { vm.clearError() }.padding(horizontal = 18.dp, vertical = 4.dp)) }
            AnimatedContent(tab, transitionSpec = { fadeIn(spring(stiffness = 420f)) togetherWith fadeOut(spring(stiffness = 700f)) }, label = "tab", modifier = Modifier.weight(1f)) { t ->
                when (t) {
                    "chat" -> ChatScreen(vm) { taskId = it }
                    "team" -> TeamScreen(vm) { taskId = it }
                    "work" -> WorkScreen(vm, { taskId = it }) { assigning = true }
                    else -> HomeScreen(vm, { taskId = it }) { tab = it }
                }
            }
        }
        // Floating tactile tab bar.
        Row(
            Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(10.dp).fillMaxWidth().raised(24.dp, Level.Floating).padding(6.dp),
            horizontalArrangement = Arrangement.SpaceAround,
        ) {
            val needs = ui.approvals.values.count { it.state == "pending" }
            for ((key, label) in TABS) {
                val on = tab == key
                Column(Modifier.clip(CircleShape).clickable { tab = key }.padding(horizontal = 14.dp, vertical = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box {
                        if (key == "home") Aperture(ui.identity?.presence ?: "idle", 24.dp)
                        else Morph(when (key) { "chat" -> if (on) "wave" else "rest"; "team" -> "people"; else -> if (on) "orbit" else "dots" }, 22.dp, if (on) c.accent else c.ink3)
                        if (key == "work" && needs > 0) Box(Modifier.align(Alignment.TopEnd).size(9.dp).clip(CircleShape).background(c.accent))
                    }
                    Txt(label, Type.label, if (on) c.ink else c.ink3)
                }
            }
        }
        AnimatedVisibility(assigning, enter = slideInVertically(spring(stiffness = 260f, dampingRatio = 0.85f)) { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
            Box(Modifier.fillMaxSize().statusBarsPadding()) { AssignScreen(vm, { assigning = false }) { id -> assigning = false; taskId = id } }
        }
        AnimatedVisibility(taskId != null, enter = slideInHorizontally(spring(stiffness = 300f, dampingRatio = 0.85f)) { it } + fadeIn(), exit = slideOutHorizontally { it } + fadeOut()) {
            val id = taskId
            if (id != null) Box(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) { TaskScreen(vm, id, { taskId = null }) { taskId = it } }
        }
    }
}
