package dev.auda.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import dev.auda.app.R

/**
 * AUDA design tokens — the same modern-skeuomorphic system as the web app
 * (web/src/design/tokens.css): warm ceramic in light, graphite in dark, one
 * ember accent, three muted semantic tones. Hierarchy comes from depth.
 */
@Immutable
data class AudaColors(
    val dark: Boolean,
    val bg: Color, val surface: Color, val raised: Color, val raised2: Color, val well: Color, val wellDeep: Color,
    val ink: Color, val ink2: Color, val ink3: Color, val ink4: Color, val line: Color,
    val accent: Color, val accent2: Color, val accentSoft: Color, val accentInk: Color,
    val attention: Color, val attentionSoft: Color, val settled: Color, val settledSoft: Color, val problem: Color, val problemSoft: Color,
    val shadow: Color, val shadowStrong: Color, val edge: Color,
    val ceramicTop: Color, val ceramicBottom: Color, val metalTop: Color, val metalMid: Color, val metalBottom: Color,
    val emberTop: Color, val emberBottom: Color,
    val glyphA: Color, val glyphB: Color, val glyphC: Color, val glyphCore: Color, val terminal: Color,
) {
    val ceramic get() = Brush.verticalGradient(listOf(ceramicTop, ceramicBottom))
    val metal get() = Brush.verticalGradient(0f to metalTop, 0.55f to metalMid, 1f to metalBottom)
    val ember get() = Brush.verticalGradient(listOf(emberTop, emberBottom))
}

val Light = AudaColors(
    dark = false,
    bg = Color(0xFFEBE7E0), surface = Color(0xFFF1EEE8), raised = Color(0xFFF7F5F1), raised2 = Color(0xFFFBFAF7), well = Color(0xFFE2DDD5), wellDeep = Color(0xFFD9D3CA),
    ink = Color(0xFF23201C), ink2 = Color(0xFF57514A), ink3 = Color(0xFF8A8379), ink4 = Color(0xFFB2ABA1), line = Color(0x1A3C2E20),
    accent = Color(0xFFC25E2C), accent2 = Color(0xFFDD7A45), accentSoft = Color(0x1FC25E2C), accentInk = Color(0xFFFFFAF5),
    attention = Color(0xFFB8821F), attentionSoft = Color(0x21B8821F), settled = Color(0xFF5F7F5C), settledSoft = Color(0x215F7F5C), problem = Color(0xFFA8503B), problemSoft = Color(0x1FA8503B),
    shadow = Color(0x2E3C2814), shadowStrong = Color(0x523C2814), edge = Color(0xD9FFFFFF),
    ceramicTop = Color(0xFFFBFAF7), ceramicBottom = Color(0xFFF3F0EA), metalTop = Color(0xFFFDFCFA), metalMid = Color(0xFFE9E5DE), metalBottom = Color(0xFFDFDAD2),
    emberTop = Color(0xFFD77443), emberBottom = Color(0xFFBD5727),
    glyphA = Color(0xFFF3B48A), glyphB = Color(0xFFC9602D), glyphC = Color(0xFF6E2F17), glyphCore = Color(0xFF2A211B), terminal = Color(0xFF1A1714),
)

val Dark = AudaColors(
    dark = true,
    bg = Color(0xFF151413), surface = Color(0xFF1B1A18), raised = Color(0xFF23211E), raised2 = Color(0xFF2A2824), well = Color(0xFF11100F), wellDeep = Color(0xFF0C0B0A),
    ink = Color(0xFFEEE9E1), ink2 = Color(0xFFB9B2A7), ink3 = Color(0xFF847D73), ink4 = Color(0xFF5B554E), line = Color(0x14FFF5E6),
    accent = Color(0xFFE0773F), accent2 = Color(0xFFF08F58), accentSoft = Color(0x29E0773F), accentInk = Color(0xFFFFFAF5),
    attention = Color(0xFFD9A441), attentionSoft = Color(0x26D9A441), settled = Color(0xFF8BAB84), settledSoft = Color(0x248BAB84), problem = Color(0xFFD47A62), problemSoft = Color(0x24D47A62),
    shadow = Color(0xB3000000), shadowStrong = Color(0xD9000000), edge = Color(0x12FFFAF0),
    ceramicTop = Color(0xFF282622), ceramicBottom = Color(0xFF211F1C), metalTop = Color(0xFF3A3732), metalMid = Color(0xFF2B2925), metalBottom = Color(0xFF25231F),
    emberTop = Color(0xFFE88050), emberBottom = Color(0xFFC95F2C),
    glyphA = Color(0xFFF6BE95), glyphB = Color(0xFFD9692F), glyphC = Color(0xFF7A3417), glyphCore = Color(0xFF0E0C0B), terminal = Color(0xFF110F0D),
)

@OptIn(ExperimentalTextApi::class)
private fun sans(w: Int) = Font(R.font.instrument_sans, FontWeight(w), FontStyle.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(w)))

@OptIn(ExperimentalTextApi::class)
val Sans = FontFamily(sans(400), sans(500), sans(600), sans(700))
val Voice = FontFamily(Font(R.font.instrument_serif, FontWeight.Normal), Font(R.font.instrument_serif_italic, FontWeight.Normal, FontStyle.Italic))
val Mono = FontFamily(Font(R.font.jetbrains_mono, FontWeight.Normal))

object Type {
    val display = TextStyle(fontFamily = Voice, fontSize = 40.sp, lineHeight = 42.sp, letterSpacing = (-0.5).sp)
    val voice = TextStyle(fontFamily = Voice, fontStyle = FontStyle.Italic, fontSize = 21.sp, lineHeight = 27.sp)
    val titleLg = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 26.sp, lineHeight = 30.sp, letterSpacing = (-0.4).sp)
    val title = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 22.sp)
    val body = TextStyle(fontFamily = Sans, fontSize = 15.sp, lineHeight = 22.sp)
    val bodyStrong = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, lineHeight = 21.sp)
    val small = TextStyle(fontFamily = Sans, fontSize = 13.sp, lineHeight = 18.sp)
    val label = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Medium, fontSize = 12.5.sp, lineHeight = 16.sp)
    val mono = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 17.sp)
}

val LocalAuda = staticCompositionLocalOf { Light }

@Composable
fun AudaTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalAuda provides if (dark) Dark else Light, content = content)
}
