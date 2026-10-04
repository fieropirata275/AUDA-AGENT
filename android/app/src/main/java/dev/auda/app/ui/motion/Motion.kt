package dev.auda.app.ui.motion

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.auda.app.ui.theme.LocalAuda
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** The same spring solver as the web (web/src/motion/spring.ts). */
class Spring(var value: Float, var stiffness: Float = 420f, var damping: Float = 34f) {
    var velocity = 0f
    var target = value
    fun step(dt: Float): Float {
        var rem = min(dt, 0.064f)
        val h = 1f / 240f
        while (rem > 0f) {
            val s = min(h, rem)
            val f = -stiffness * (value - target) - damping * velocity
            velocity += f * s; value += velocity * s; rem -= s
        }
        return value
    }
    val settled get() = abs(value - target) < 1e-3f && abs(velocity) < 1e-3f
}

// ─── Stroke-morph icons ─────────────────────────────────────────────────────────
// Every icon is three centerline strokes of N points in a 24×24 box with round
// caps. A dot is a zero-length stroke, so any icon morphs into any other.

private const val N = 24
class StrokeShape(val pts: FloatArray, val w: Float, val o: Float)

private fun line(ax: Float, ay: Float, bx: Float, by: Float) = FloatArray(N * 2) { i -> val k = (i / 2) / (N - 1f); if (i % 2 == 0) ax + (bx - ax) * k else ay + (by - ay) * k }
private fun dot(x: Float, y: Float) = FloatArray(N * 2) { i -> if (i % 2 == 0) x else y }
private fun arc(cx: Float, cy: Float, r: Float, a0: Float, a1: Float) = FloatArray(N * 2) { i -> val a = a0 + (a1 - a0) * ((i / 2) / (N - 1f)); if (i % 2 == 0) cx + r * cos(a) else cy + r * sin(a) }
private fun poly(vararg p: Float): FloatArray {
    val n = p.size / 2
    val seg = FloatArray(n - 1) { hypot(p[(it + 1) * 2] - p[it * 2], p[(it + 1) * 2 + 1] - p[it * 2 + 1]) }
    val total = seg.sum()
    val out = FloatArray(N * 2)
    for (i in 0 until N) {
        var d = i / (N - 1f) * total; var k = 0
        while (k < seg.size - 1 && d > seg[k]) { d -= seg[k]; k++ }
        val f = if (seg[k] > 0f) d / seg[k] else 0f
        out[i * 2] = p[k * 2] + (p[(k + 1) * 2] - p[k * 2]) * f
        out[i * 2 + 1] = p[k * 2 + 1] + (p[(k + 1) * 2 + 1] - p[k * 2 + 1]) * f
    }
    return out
}
private fun s(pts: FloatArray, w: Float = 2f, o: Float = 1f) = StrokeShape(pts, w, o)
private const val TAU = (PI * 2).toFloat()
private const val TOP = (-PI / 2).toFloat()

val ANIMATED = setOf("dots", "wave", "orbit", "eye", "attention", "recover", "flow")

fun shapeAt(name: String, t: Float): List<StrokeShape> = when (name) {
    "dots" -> List(3) { i -> s(dot(6f + i * 6, 12f + sin(t * 2.2f + i * 0.9f) * 0.35f), 2.8f) }
    "rest" -> List(3) { i -> s(dot(7f + i * 5, 13f), 2.2f, 0.55f) }
    "wave" -> List(3) { i -> s(FloatArray(N * 2) { j -> val x = 3f + i * 6 + ((j / 2) / (N - 1f)) * 6; if (j % 2 == 0) x else 12f + sin(x * 0.75f - t * 5f) * 3.2f * sin(((x - 3f) / 18f) * PI.toFloat()) }) }
    "orbit" -> List(3) { i -> val a = t * 3.2f + i * TAU / 3; s(arc(12f, 12f, 8f, a, a + 1.25f), 2.2f) }
    "check" -> listOf(s(line(5.2f, 12.6f, 10f, 17.2f), 2.4f), s(line(10f, 17.2f, 18.8f, 7.4f), 2.4f), s(dot(10f, 17.2f), 2.4f, 0f))
    "clock" -> listOf(s(arc(12f, 12f, 8.5f, TOP, TOP + TAU), 1.9f), s(line(12f, 12f, 12f, 7.2f), 1.9f), s(line(12f, 12f, 15.4f, 14f), 1.9f))
    "eye" -> { val g = sin(t * 0.7f) * 1.6f; listOf(s(poly(3.5f, 12f, 7f, 8.2f, 12f, 6.8f, 17f, 8.2f, 20.5f, 12f), 1.8f), s(poly(3.5f, 12f, 7f, 15.8f, 12f, 17.2f, 17f, 15.8f, 20.5f, 12f), 1.8f), s(dot(12f + g, 12f), 3.6f)) }
    "attention" -> listOf(s(arc(12f, 12f, 8.5f, TOP, TOP + TAU), 1.9f, 0.55f + 0.45f * abs(sin(t * 1.6f))), s(line(12f, 7.4f, 12f, 12.6f), 2.2f), s(dot(12f, 16.2f), 2.6f))
    "blocked" -> listOf(s(arc(12f, 12f, 8.5f, TOP, TOP + TAU), 1.9f), s(line(8f, 12f, 16f, 12f), 2.2f), s(dot(12f, 12f), 0f, 0f))
    "problem" -> listOf(s(arc(12f, 12f, 8.5f, TOP + 0.55f, TOP + TAU - 0.55f), 1.9f), s(line(12f, 9f, 12f, 13f), 2.1f), s(dot(12f, 16.3f), 2.5f))
    "recover" -> { val a = t * 2.4f; val e = a + TAU * 0.78f; val ex = 12f + 8f * cos(e); val ey = 12f + 8f * sin(e)
        listOf(s(arc(12f, 12f, 8f, a, e), 1.9f), s(line(ex, ey, ex + 3.2f * cos(e - 2.3f), ey + 3.2f * sin(e - 2.3f)), 1.9f), s(line(ex, ey, ex + 3.2f * cos(e + 0.9f), ey + 3.2f * sin(e + 0.9f)), 1.9f)) }
    "pause" -> listOf(s(line(9f, 6.5f, 9f, 17.5f), 2.6f), s(line(15f, 6.5f, 15f, 17.5f), 2.6f), s(dot(12f, 12f), 0f, 0f))
    "play" -> listOf(s(line(8.5f, 6f, 8.5f, 18f), 2.2f), s(line(8.5f, 6f, 18f, 12f), 2.2f), s(line(8.5f, 18f, 18f, 12f), 2.2f))
    "close" -> listOf(s(line(7f, 7f, 17f, 17f), 2.1f), s(line(17f, 7f, 7f, 17f), 2.1f), s(dot(12f, 12f), 0f, 0f))
    "plus" -> listOf(s(line(12f, 6f, 12f, 18f), 2.1f), s(line(6f, 12f, 18f, 12f), 2.1f), s(dot(12f, 12f), 0f, 0f))
    "arrowUp" -> listOf(s(line(12f, 19f, 12f, 5.5f), 2.2f), s(line(6.5f, 11f, 12f, 5.5f), 2.2f), s(line(17.5f, 11f, 12f, 5.5f), 2.2f))
    "arrowRight" -> listOf(s(line(5f, 12f, 18.5f, 12f), 2.1f), s(line(13f, 6.5f, 18.5f, 12f), 2.1f), s(line(13f, 17.5f, 18.5f, 12f), 2.1f))
    "chevronRight" -> listOf(s(line(9.5f, 6.5f, 15f, 12f), 2.1f), s(line(9.5f, 17.5f, 15f, 12f), 2.1f), s(dot(15f, 12f), 0f, 0f))
    "back" -> listOf(s(line(14.5f, 6.5f, 9f, 12f), 2.1f), s(line(14.5f, 17.5f, 9f, 12f), 2.1f), s(dot(9f, 12f), 0f, 0f))
    "flow" -> listOf(s(FloatArray(N * 2) { j -> val x = 2.5f + ((j / 2) / (N - 1f)) * 19f; if (j % 2 == 0) x else 12f + sin(x * 0.6f - t * 6f) * 1.8f }, 1.9f), s(dot(2.5f, 12f), 2.4f), s(dot(21.5f, 12f), 2.4f))
    "unplugged" -> listOf(s(poly(2.5f, 12f, 6.5f, 12f, 6.5f, 8.5f, 9.5f, 8.5f, 9.5f, 15.5f, 6.5f, 15.5f, 6.5f, 12f), 1.9f), s(poly(21.5f, 12f, 17.5f, 12f, 17.5f, 8.5f, 14.5f, 8.5f, 14.5f, 15.5f, 17.5f, 15.5f, 17.5f, 12f), 1.9f), s(dot(12f, 12f), 0f, 0f))
    "linked" -> listOf(s(poly(2.5f, 12f, 6.5f, 12f, 6.5f, 8.5f, 11.6f, 8.5f, 11.6f, 15.5f, 6.5f, 15.5f, 6.5f, 12f), 1.9f), s(poly(21.5f, 12f, 17.5f, 12f, 17.5f, 8.5f, 12.4f, 8.5f, 12.4f, 15.5f, 17.5f, 15.5f, 17.5f, 12f), 1.9f), s(line(10f, 12f, 14f, 12f), 2.2f))
    "attach" -> listOf(s(poly(15f, 7f, 15f, 15.5f, 14f, 17.6f, 12f, 18.4f, 10f, 17.6f, 9f, 15.5f, 9f, 6.5f), 1.9f), s(poly(9f, 6.5f, 10.2f, 4.8f, 12f, 4.4f, 13.2f, 5.2f, 12.6f, 7f), 1.9f), s(line(12f, 8.5f, 12f, 14.5f), 1.9f))
    "folder" -> listOf(s(poly(3.5f, 18f, 3.5f, 6.5f, 9f, 6.5f, 10.5f, 8.5f, 20.5f, 8.5f), 1.9f), s(poly(20.5f, 8.5f, 20.5f, 18f, 3.5f, 18f), 1.9f), s(dot(12f, 13f), 0f, 0f))
    "people" -> listOf(s(arc(9f, 9f, 3f, 0f, TAU), 1.9f), s(arc(9f, 20f, 6f, -PI.toFloat() * 0.95f, -PI.toFloat() * 0.05f), 1.9f), s(arc(16.5f, 10f, 2.4f, 0f, TAU), 1.8f))
    else -> shapeAt("dots", t)
}

/** A stroke-morph icon. Changing [shape] springs the geometry into the new one. */
@Composable
fun Morph(shape: String, size: Dp = 20.dp, color: Color = LocalAuda.current.ink2, modifier: Modifier = Modifier) {
    val st = remember { object { var from: List<StrokeShape>? = null; var cur: List<StrokeShape>? = null; var name = ""; val p = Spring(1f, 420f, 34f) } }
    var frame by remember { mutableLongStateOf(0L) }
    LaunchedEffect(shape) {
        if (st.name != "" && st.name != shape) { st.from = st.cur; st.p.value = 0f; st.p.velocity = 0f; st.p.target = 1f }
        st.name = shape
        var last = 0L
        while (true) {
            val now = withFrameNanos { it }
            val dt = if (last == 0L) 1f / 60f else (now - last) / 1e9f
            last = now
            st.p.step(dt)
            frame = now
            if (st.p.settled && shape !in ANIMATED) break
        }
    }
    Canvas(modifier.size(size)) {
        if (frame < 0L) return@Canvas // reading the frame state redraws every animation frame
        val t = (System.nanoTime() / 1e9).toFloat()
        val target = shapeAt(shape, t)
        val k = st.p.value
        val from = st.from ?: target
        val cur = target.mapIndexed { i, tg ->
            val f = from.getOrNull(i) ?: tg
            StrokeShape(FloatArray(N * 2) { j -> f.pts[j] + (tg.pts[j] - f.pts[j]) * k }, f.w + (tg.w - f.w) * k, f.o + (tg.o - f.o) * k)
        }
        st.cur = cur
        val scale = this.size.width / 24f
        for (sh in cur) {
            if (sh.o <= 0.01f) continue
            val path = Path().apply { moveTo(sh.pts[0] * scale, sh.pts[1] * scale); for (i in 1 until N) lineTo(sh.pts[i * 2] * scale, sh.pts[i * 2 + 1] * scale) }
            drawPath(path, color.copy(alpha = color.alpha * sh.o.coerceIn(0f, 1f)), style = Stroke(width = max(0.01f, sh.w * scale), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

// ─── The Aperture ─────────────────────────────────────────────────────────────

private class P(val r: Float = 0.8f, val amp: Float = 0.03f, val inner: Float = 0.03f, val core: Float = 0.3f, val spin: Float = 0.12f, val breath: Float = 0.018f,
                val rate: Float = 0.35f, val orbit: Float = 0f, val pulse: Float = 0f, val notch: Float = 0f, val gaze: Float = 0f, val churn: Float = 0.4f)

private val PRESETS = mapOf(
    "idle" to P(r = 0.74f, amp = 0.015f, inner = 0.015f, core = 0.27f, spin = 0.04f, breath = 0.022f, rate = 0.18f, churn = 0.15f),
    "available" to P(),
    "listening" to P(r = 0.86f, amp = 0.02f, inner = 0.02f, core = 0.36f, breath = 0.03f, rate = 0.9f, churn = 0.6f),
    "thinking" to P(amp = 0.05f, inner = 0.11f, core = 0.25f, spin = 0.32f, churn = 1.9f, breath = 0.012f),
    "working" to P(amp = 0.04f, inner = 0.05f, spin = 0.85f, orbit = 1f, churn = 0.9f),
    "coding" to P(amp = 0.035f, inner = 0.06f, spin = 0.85f, orbit = 1f, churn = 1.1f),
    "browsing" to P(amp = 0.04f, inner = 0.05f, spin = 0.7f, orbit = 1f, churn = 0.8f, gaze = 0.05f),
    "waiting" to P(r = 0.77f, amp = 0.012f, inner = 0.015f, core = 0.33f, spin = 0.03f, breath = 0.015f, rate = 0.14f, churn = 0.12f),
    "scheduled" to P(r = 0.77f, amp = 0.012f, inner = 0.015f, core = 0.31f, spin = 0.03f, breath = 0.015f, rate = 0.14f, churn = 0.12f),
    "watching" to P(amp = 0.022f, inner = 0.025f, core = 0.29f, spin = 0.08f, gaze = 0.09f, churn = 0.3f),
    "needs_you" to P(amp = 0.03f, pulse = 1f, core = 0.31f, spin = 0.06f, breath = 0.03f, rate = 0.45f),
    "blocked" to P(notch = 0.55f, amp = 0.02f, spin = 0.02f, churn = 0.2f),
    "recovering" to P(spin = -0.7f, orbit = 0.55f, amp = 0.05f, inner = 0.07f, churn = 1.4f),
)

/** AUDA's glyph: three polar curves as a ceramic lens; state changes are continuous morphs. */
@Composable
fun Aperture(state: String, size: Dp, modifier: Modifier = Modifier) {
    val c = LocalAuda.current
    val springs = remember {
        val p = PRESETS[state] ?: P()
        listOf(p.r, p.amp, p.inner, p.core, p.spin, p.breath, p.rate, p.orbit, p.pulse, p.notch, p.gaze, p.churn).mapIndexed { i, v -> Spring(v, if (i in listOf(4, 6, 11)) 60f else 210f, if (i in listOf(4, 6, 11)) 14f else 26f) }
    }
    val anim = remember { object { var phase = (Math.random() * 10).toFloat(); var rot = 0f; var orbitA = 0f; var t = 0f } }
    var frame by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(state) {
        val p = PRESETS[state] ?: P()
        listOf(p.r, p.amp, p.inner, p.core, p.spin, p.breath, p.rate, p.orbit, p.pulse, p.notch, p.gaze, p.churn).forEachIndexed { i, v -> springs[i].target = v }
    }
    LaunchedEffect(Unit) {
        var last = 0L
        while (true) {
            val now = withFrameNanos { it }
            val dt = if (last == 0L) 1f / 60f else (now - last) / 1e9f
            last = now
            springs.forEach { it.step(dt) }
            anim.t += dt; anim.phase += dt * springs[11].value; anim.rot += dt * springs[4].value
            anim.orbitA += dt * (0.9f + abs(springs[4].value)) * (if (springs[4].value < 0) -1f else 1f)
            frame = anim.t
        }
    }
    Canvas(modifier.size(size)) {
        if (frame < 0f) return@Canvas // reading the frame state redraws every animation frame
        val v = springs.map { it.value }
        val (r0, amp, inner, core, _, breath, rate, orbit, pulse, notch, gaze) = Ten(v)
        val w = this.size.width
        val k = w / 200f
        val cx = w / 2f
        val t = anim.t
        val breathe = 1f + breath * sin(t * TAU * rate)
        val notchAt = (-PI / 4).toFloat()
        fun notchF(a: Float): Float { val d = atan2(sin(a - notchAt), cos(a - notchAt)); return 1f - notch * 0.22f * exp(-(d * d) / 0.09f) }
        fun blob(ox: Float, oy: Float, R: Float, rot: Float, f: (Float) -> Float): Path {
            val seg = 72
            val pts = Array(seg) { i -> val a = i.toFloat() / seg * TAU; val r = R * f(a); Offset(ox + r * cos(a + rot), oy + r * sin(a + rot)) }
            return Path().apply {
                moveTo(pts[0].x, pts[0].y)
                for (i in 0 until seg) {
                    val p0 = pts[(i - 1 + seg) % seg]; val p1 = pts[i]; val p2 = pts[(i + 1) % seg]; val p3 = pts[(i + 2) % seg]
                    cubicTo(p1.x + (p2.x - p0.x) / 6f, p1.y + (p2.y - p0.y) / 6f, p2.x - (p3.x - p1.x) / 6f, p2.y - (p3.y - p1.y) / 6f, p2.x, p2.y)
                }
                close()
            }
        }
        // Socket
        drawCircle(Brush.radialGradient(0.72f to c.wellDeep, 1f to c.well, center = Offset(cx, cx * 0.9f), radius = w * 0.55f), radius = 96f * k, center = Offset(cx, cx))
        val R = 72f * k * r0 * breathe
        // Pulse ring (needs you)
        if (pulse > 0.05f) { val cyc = (t % 2.4f) / 2.4f; drawCircle(c.accent.copy(alpha = pulse * (1 - cyc) * 0.55f), radius = R + (6f + cyc * 22f) * k, center = Offset(cx, cx), style = Stroke(1.5f * k)) }
        val ph = anim.phase; val rot = anim.rot
        val outer = blob(cx, cx, R, rot) { a -> (1 + amp * sin(3 * a + ph) + amp * 0.6f * sin(5 * a - ph * 1.3f)) * notchF(a + rot) }
        drawPath(outer, Brush.radialGradient(0f to c.glyphA, 0.55f to c.glyphB, 1f to c.glyphC, center = Offset(cx * 0.72f, cx * 0.6f), radius = R * 1.6f))
        val gx = gaze * 40f * k * sin(t * 0.37f); val gy = gaze * 22f * k * cos(t * 0.29f)
        val mid = blob(cx + gx, cx + gy, R * 0.74f, -rot * 1.4f) { a -> (1 + inner * sin(4 * a - ph * 1.7f) + inner * 0.7f * sin(7 * a + ph * 0.9f)) * notchF(a - rot * 1.4f) }
        drawPath(mid, Brush.radialGradient(0f to c.glyphB.copy(alpha = 0.95f), 1f to c.glyphC.copy(alpha = 0.95f), center = Offset(cx * 0.8f, cx * 0.7f), radius = R * 1.2f), alpha = 0.78f)
        val coreR = 72f * k * core * (1 + 0.04f * sin(t * TAU * rate + 1))
        drawPath(blob(cx + gx * 1.3f, cx + gy * 1.3f, coreR, rot * 2) { a -> 1 + inner * 0.8f * sin(3 * a + ph * 2.1f) }, c.glyphCore)
        // Specular highlight: reads as a lens, not a flat blob.
        drawOval(Brush.verticalGradient(listOf(Color.White.copy(alpha = 0.42f), Color.Transparent), startY = cx * 0.55f, endY = cx * 0.85f), topLeft = Offset(cx * 0.52f, cx * 0.53f), size = androidx.compose.ui.geometry.Size(60f * k, 28f * k))
        // Orbiting satellites (working)
        if (orbit > 0.02f) for (i in 0 until 3) {
            val a = anim.orbitA * 1.6f + i * TAU / 3; val rr = R + 13f * k + 2f * k * sin(t * 2 + i)
            drawCircle(c.glyphB.copy(alpha = orbit * (0.55f + 0.45f * sin(t * 3 + i * 2))), radius = (2.4f + orbit * 1.2f) * k, center = Offset(cx + rr * cos(a), cx + rr * sin(a)))
        }
    }
}

private class Ten(val v: List<Float>) {
    operator fun component1() = v[0]; operator fun component2() = v[1]; operator fun component3() = v[2]; operator fun component4() = v[3]
    operator fun component5() = v[4]; operator fun component6() = v[5]; operator fun component7() = v[6]; operator fun component8() = v[7]
    operator fun component9() = v[8]; operator fun component10() = v[9]; operator fun component11() = v[10]
}
