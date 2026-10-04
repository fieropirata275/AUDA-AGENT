package dev.auda.app.ui.design

import android.graphics.BlurMaskFilter
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.auda.app.ui.theme.LocalAuda
import dev.auda.app.ui.theme.Type

/** Elevation levels, as on the web: depth communicates hierarchy. */
enum class Level(val blur: Dp, val dy: Dp, val contact: Dp) { Raised(16.dp, 6.dp, 1.dp), Lifted(28.dp, 12.dp, 2.dp), Floating(52.dp, 24.dp, 6.dp) }

/** Ambient + contact shadow drawn behind a rounded shape. */
fun Modifier.depth(radius: Dp, level: Level = Level.Raised): Modifier = composed {
    val c = LocalAuda.current
    drawBehind {
        // Blurred mask filters need hardware-accelerated support (API 28+); older devices get flat cards.
        if (android.os.Build.VERSION.SDK_INT < 28) return@drawBehind
        val r = radius.toPx()
        drawIntoCanvas { canvas ->
            val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
            p.color = c.shadow.toArgb()
            p.maskFilter = BlurMaskFilter(level.blur.toPx() / 2f, BlurMaskFilter.Blur.NORMAL)
            val inset = level.blur.toPx() / 5f
            canvas.nativeCanvas.drawRoundRect(inset, level.dy.toPx(), size.width - inset, size.height + level.dy.toPx() * 0.4f, r, r, p)
            p.maskFilter = BlurMaskFilter(level.contact.toPx().coerceAtLeast(1f), BlurMaskFilter.Blur.NORMAL)
            p.color = c.shadowStrong.copy(alpha = c.shadowStrong.alpha * 0.45f).toArgb()
            canvas.nativeCanvas.drawRoundRect(0f, level.contact.toPx(), size.width, size.height + level.contact.toPx(), r, r, p)
        }
    }
}

/** A raised ceramic card with a 1px top edge highlight. */
fun Modifier.raised(radius: Dp = 20.dp, level: Level = Level.Raised, brush: Brush? = null): Modifier = composed {
    val c = LocalAuda.current
    this.depth(radius, level)
        .clip(RoundedCornerShape(radius))
        .background(brush ?: c.ceramic)
        .drawBehind {
            drawRoundRect(c.edge, topLeft = Offset(0f, 0f), size = size.copy(height = size.height), cornerRadius = CornerRadius(radius.toPx()), style = Stroke(width = 1.dp.toPx()), alpha = 0.6f)
        }
}

/** A recessed well: darker surface with an inner shadow along the top edge and a highlight below. */
fun Modifier.well(radius: Dp = 14.dp, color: Color? = null): Modifier = composed {
    val c = LocalAuda.current
    this.clip(RoundedCornerShape(radius))
        .background(color ?: c.well)
        .drawBehind {
            drawRect(Brush.verticalGradient(0f to c.shadow.copy(alpha = c.shadow.alpha * 0.55f), 0.18f to Color.Transparent), size = size)
            drawRect(Brush.horizontalGradient(0f to c.shadow.copy(alpha = c.shadow.alpha * 0.18f), 0.04f to Color.Transparent, 0.96f to Color.Transparent, 1f to c.shadow.copy(alpha = c.shadow.alpha * 0.18f)), size = size)
        }
}

enum class Variant { Primary, Neutral, Ghost, Danger }

/** A physical button: metal or ember, depresses when pressed. */
@Composable
fun AudaButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: Variant = Variant.Neutral,
    enabled: Boolean = true,
    small: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
) {
    val c = LocalAuda.current
    val src = remember { MutableInteractionSource() }
    val pressed by src.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.97f else 1f, spring(stiffness = 700f, dampingRatio = 0.8f), label = "press")
    val dy by animateDpAsState(if (pressed) 1.dp else 0.dp, spring(stiffness = 700f), label = "pressY")
    val radius = if (small) 10.dp else 13.dp
    val bg: Brush? = when (variant) { Variant.Primary -> c.ember; Variant.Neutral -> c.metal; else -> null }
    val fg = when (variant) { Variant.Primary -> c.accentInk; Variant.Danger -> c.problem; Variant.Ghost -> c.ink2; else -> c.ink }
    Row(
        modifier = modifier
            .offset(y = dy).scale(scale)
            .then(if (bg != null && !pressed) Modifier.depth(radius, Level.Raised) else Modifier)
            .clip(RoundedCornerShape(radius))
            .then(if (bg != null) Modifier.background(bg) else Modifier)
            .then(if (pressed && bg != null) Modifier.background(c.shadow.copy(alpha = 0.12f)) else Modifier)
            .clickable(interactionSource = src, indication = null, enabled = enabled, onClick = onClick)
            .defaultMinSize(minHeight = if (small) 32.dp else 44.dp)
            .padding(horizontal = if (small) 12.dp else 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        leading?.invoke()
        Text(text, style = (if (small) Type.small else Type.bodyStrong).copy(color = if (enabled) fg else fg.copy(alpha = 0.45f)))
    }
}

/** Soft pill for states and filters. */
@Composable
fun Chip(text: String, tone: String = "", modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val c = LocalAuda.current
    val (bg, fg) = when (tone) {
        "accent" -> c.accentSoft to c.accent
        "attention" -> c.attentionSoft to c.attention
        "settled" -> c.settledSoft to c.settled
        "problem" -> c.problemSoft to c.problem
        else -> c.well to c.ink2
    }
    Box(
        modifier.height(26.dp).clip(RoundedCornerShape(13.dp)).background(bg).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = Type.label.copy(color = fg), maxLines = 1) }
}

/** Segmented control with a sliding metal thumb. */
@Composable
fun Segmented(options: List<Pair<String, String>>, value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = LocalAuda.current
    Row(modifier.well(12.dp).padding(3.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        for ((key, label) in options) {
            val on = key == value
            Box(
                Modifier.clip(RoundedCornerShape(9.dp)).then(if (on) Modifier.background(c.metal) else Modifier)
                    .clickable { onChange(key) }.padding(horizontal = 12.dp, vertical = 7.dp),
            ) { Text(label, style = Type.label.copy(color = if (on) c.ink else c.ink2), maxLines = 1) }
        }
    }
}

@Composable
fun SectionHead(title: String, count: Int? = null, trailing: (@Composable RowScope.() -> Unit)? = null) {
    val c = LocalAuda.current
    Row(Modifier.padding(top = 26.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = Type.bodyStrong.copy(color = c.ink))
        if (count != null) Text("$count", style = Type.small.copy(color = c.ink3))
        Box(Modifier.weight(1f))
        trailing?.invoke(this)
    }
}

@Composable
fun Txt(text: String, style: TextStyle = Type.body, color: Color? = null, modifier: Modifier = Modifier, maxLines: Int = Int.MAX_VALUE) {
    Text(text, style = style.copy(color = color ?: LocalAuda.current.ink), modifier = modifier, maxLines = maxLines, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
}
