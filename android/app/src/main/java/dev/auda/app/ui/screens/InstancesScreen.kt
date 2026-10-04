package dev.auda.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.auda.app.data.AudaViewModel
import dev.auda.app.data.Instance
import dev.auda.app.ui.design.AudaButton
import dev.auda.app.ui.design.Chip
import dev.auda.app.ui.design.Level
import dev.auda.app.ui.design.SectionHead
import dev.auda.app.ui.design.Txt
import dev.auda.app.ui.design.Variant
import dev.auda.app.ui.design.raised
import dev.auda.app.ui.design.well
import dev.auda.app.ui.motion.Aperture
import dev.auda.app.ui.motion.Morph
import dev.auda.app.ui.theme.LocalAuda
import dev.auda.app.ui.theme.Mono
import dev.auda.app.ui.theme.Type

/** Pick which AUDA to work from. Instances on the network appear on their own. */
@Composable
fun InstancesScreen(vm: AudaViewModel) {
    val c = LocalAuda.current
    val saved by vm.saved.collectAsState()
    val found by vm.found.collectAsState()
    val scanning by vm.scanning.collectAsState()
    val pairing by vm.pairing.collectAsState()
    val ui by vm.ui.collectAsState()
    var manual by remember { mutableStateOf("") }
    val foundIds = found.map { it.id }.toSet()
    val all = (found + saved.filter { it.id !in foundIds }).distinctBy { it.id }

    Box(Modifier.fillMaxSize().background(c.bg)) {
        LazyColumn(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 18.dp)) {
            item {
                Column(Modifier.fillMaxWidth().padding(top = 36.dp, bottom = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Aperture(if (scanning != null) "watching" else "available", 132.dp)
                    Spacer(Modifier.height(18.dp))
                    Txt("Choose an AUDA", Type.display.copy(fontSize = 34.sp))
                    Txt(scanning ?: if (all.isEmpty()) "No instances found yet." else "Tap one to work from it.", Type.voice.copy(fontSize = 18.sp), c.ink2, Modifier.padding(top = 6.dp))
                }
            }
            item { SectionHead("On this network", found.size) { AudaButton(if (scanning != null) "Looking…" else "Look again", { vm.scan() }, variant = Variant.Ghost, small = true, enabled = scanning == null) } }
            items(all, key = { it.id }) { inst -> InstanceRow(inst, saved.any { it.id == inst.id && it.token != null }, inst.id in foundIds, { vm.choose(inst) }, { vm.forget(inst) }) }
            if (all.isEmpty()) item { Empty("Nothing here yet", "Make sure AUDA is running on this network, or enter its address below.") }
            item {
                SectionHead("Add by address")
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    BasicTextField(manual, { manual = it }, singleLine = true, textStyle = Type.body.copy(color = c.ink), cursorBrush = SolidColor(c.accent),
                        modifier = Modifier.weight(1f).well(12.dp).padding(horizontal = 14.dp, vertical = 12.dp),
                        decorationBox = { inner -> Box { if (manual.isEmpty()) Txt("192.168.1.20:4610", Type.body, c.ink3); inner() } })
                    AudaButton("Add", { vm.addManual(manual); manual = "" }, enabled = manual.isNotBlank())
                }
                ui.error?.let { Txt(it, Type.small, c.problem, Modifier.padding(top = 8.dp)) }
                Spacer(Modifier.height(40.dp))
            }
        }
        pairing?.let { p -> PairingSheet(p.instance, p.code, p.status, p.error, onRetry = { vm.pair(p.instance) }, onCancel = { vm.cancelPairing() }) }
    }
}

@Composable
private fun InstanceRow(inst: Instance, paired: Boolean, online: Boolean, onOpen: () -> Unit, onForget: () -> Unit) {
    val c = LocalAuda.current
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp).raised(20.dp).clickable(onClick = onOpen).padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Aperture(if (online) inst.presence.ifBlank { "available" } else "idle", 46.dp)
        Column(Modifier.weight(1f)) {
            Txt(inst.name, Type.bodyStrong, maxLines = 1)
            Txt(inst.baseUrl.removePrefix("http://"), Type.mono, c.ink3, maxLines = 1)
            if (online && inst.narration.isNotBlank()) Txt("“${inst.narration}”", Type.voice.copy(fontSize = 15.sp), c.ink2, maxLines = 1)
            Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Chip(if (online) "Online · ${inst.via}" else "Saved", if (online) "settled" else "")
                if (paired) Chip("Paired", "accent") else if (inst.requiresPairing) Chip("Needs pairing", "attention")
                if (inst.version.isNotBlank()) Chip("v${inst.version}")
            }
        }
        if (!online) Txt("Forget", Type.label, c.problem, Modifier.clickable(onClick = onForget).padding(8.dp))
        else Morph("chevronRight", 18.dp, c.ink3)
    }
}

@Composable
private fun PairingSheet(inst: Instance, code: String?, status: String, error: String?, onRetry: () -> Unit, onCancel: () -> Unit) {
    val c = LocalAuda.current
    Box(Modifier.fillMaxSize().background(c.shadowStrong.copy(alpha = 0.35f)).clickable(enabled = false) {}, contentAlignment = Alignment.BottomCenter) {
        Column(Modifier.fillMaxWidth().padding(10.dp).raised(28.dp, Level.Floating, c.ceramic).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Aperture(if (status == "waiting") "needs_you" else if (status == "requesting") "thinking" else "blocked", 92.dp)
            Txt("Pair with ${inst.name}", Type.title, modifier = Modifier.padding(top = 14.dp))
            when (status) {
                "requesting" -> Txt("Asking AUDA…", Type.body, c.ink2, Modifier.padding(top = 8.dp))
                "waiting" -> {
                    Txt("On the computer running AUDA, open Connections and approve this code:", Type.body, c.ink2, Modifier.padding(top = 8.dp))
                    Box(Modifier.padding(top = 16.dp).well(16.dp).padding(horizontal = 22.dp, vertical = 12.dp)) {
                        Txt(code?.let { "${it.take(3)} ${it.drop(3)}" } ?: "…", Type.title.copy(fontFamily = Mono, fontSize = 34.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 4.sp))
                    }
                    Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(c.attention)); Txt("Waiting for approval", Type.small, c.ink3)
                    }
                }
                "rejected" -> Txt("The request was declined on AUDA.", Type.body, c.problem, Modifier.padding(top = 8.dp))
                "expired" -> Txt("The code expired. Try again.", Type.body, c.ink2, Modifier.padding(top = 8.dp))
                else -> Txt(error ?: "Something went wrong.", Type.body, c.problem, Modifier.padding(top = 8.dp))
            }
            Row(Modifier.padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AudaButton("Cancel", onCancel, variant = Variant.Ghost)
                if (status in setOf("rejected", "expired", "error")) AudaButton("Try again", onRetry, variant = Variant.Primary)
            }
        }
    }
}
