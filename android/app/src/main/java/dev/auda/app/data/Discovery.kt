package dev.auda.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/**
 * Finds AUDA instances on the local network, three ways at once:
 *  1. mDNS / DNS-SD (`_auda._tcp`) via NsdManager — the normal path;
 *  2. UDP broadcast on port 4611 — for networks that filter multicast;
 *  3. a quick HTTP sweep of the phone's /24 on port 4610 — last resort.
 * Every candidate is confirmed with GET /api/discover before it is shown.
 */
class Discovery(private val context: Context) {
    private val probe = OkHttpClient.Builder().connectTimeout(700, TimeUnit.MILLISECONDS).readTimeout(1200, TimeUnit.MILLISECONDS).build()

    suspend fun scan(onFound: (Instance) -> Unit, onPhase: (String) -> Unit = {}) = coroutineScope {
        val seen = HashSet<String>()
        val report: (Instance) -> Unit = { i -> synchronized(seen) { if (seen.add(i.id + i.baseUrl)) onFound(i) } }
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val lock = wifi.createMulticastLock("auda-discovery").apply { setReferenceCounted(false); acquire() }
        try {
            onPhase("Listening for AUDA on this network…")
            launch { mdns(this, report) }
            launch { udp(report) }
            delay(2500)
            onPhase("Checking nearby addresses…")
            sweep(report)
            delay(1500)
        } finally {
            lock.release()
        }
    }

    /** Confirm a host is AUDA and turn its card into an Instance. */
    suspend fun confirm(baseUrl: String, via: String): Instance? = withContext(Dispatchers.IO) {
        runCatching {
            probe.newCall(Request.Builder().url(baseUrl.trimEnd('/') + "/api/discover").build()).execute().use { r ->
                if (!r.isSuccessful) return@use null
                val c = JSONObject(r.body?.string() ?: return@use null)
                if (c.optString("service") != "auda") return@use null
                Instance(c.getString("id"), c.optString("name", "AUDA"), baseUrl.trimEnd('/'), c.optString("version"), c.optBoolean("requiresPairing"), c.optString("presence"), c.optString("narration"), via)
            }
        }.getOrNull()
    }

    private suspend fun mdns(scope: CoroutineScope, report: (Instance) -> Unit) {
        val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
        val queue = Channel<NsdServiceInfo>(Channel.UNLIMITED)
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceLost(service: NsdServiceInfo) {}
            override fun onServiceFound(service: NsdServiceInfo) { queue.trySend(service) }
        }
        runCatching { nsd.discoverServices("_auda._tcp.", NsdManager.PROTOCOL_DNS_SD, listener) }
        try {
            // Resolve one at a time: older Android versions reject concurrent resolves.
            withTimeoutOrNull(5500) {
                for (svc in queue) {
                    val resolved = resolve(nsd, svc) ?: continue
                    @Suppress("DEPRECATION") val host = resolved.host ?: continue
                    val addr = if (host is Inet4Address) host.hostAddress else "[${host.hostAddress}]"
                    scope.launch { confirm("http://$addr:${resolved.port}", "mDNS")?.let(report) }
                }
            }
        } finally {
            runCatching { nsd.stopServiceDiscovery(listener) }
        }
    }

    @Suppress("DEPRECATION")
    private suspend fun resolve(nsd: NsdManager, svc: NsdServiceInfo): NsdServiceInfo? {
        val result = Channel<NsdServiceInfo?>(1)
        runCatching {
            nsd.resolveService(svc, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { result.trySend(null) }
                override fun onServiceResolved(serviceInfo: NsdServiceInfo) { result.trySend(serviceInfo) }
            })
        }.onFailure { return null }
        return withTimeoutOrNull(2500) { result.receive() }
    }

    private suspend fun udp(report: (Instance) -> Unit) = withContext(Dispatchers.IO) {
        runCatching {
            DatagramSocket().use { socket ->
                socket.broadcast = true
                socket.soTimeout = 600
                val msg = "AUDA_DISCOVER".toByteArray()
                val targets = listOfNotNull(InetAddress.getByName("255.255.255.255"), subnetBroadcast())
                repeat(3) {
                    for (t in targets) runCatching { socket.send(DatagramPacket(msg, msg.size, t, 4611)) }
                    val until = System.currentTimeMillis() + 900
                    while (System.currentTimeMillis() < until) {
                        val buf = ByteArray(4096)
                        val pkt = DatagramPacket(buf, buf.size)
                        try { socket.receive(pkt) } catch (_: SocketTimeoutException) { break }
                        val card = runCatching { JSONObject(String(pkt.data, 0, pkt.length)) }.getOrNull() ?: continue
                        val host = pkt.address.hostAddress ?: continue
                        confirm("http://$host:${card.optInt("port", 4610)}", "broadcast")?.let(report)
                    }
                }
            }
        }
    }

    private suspend fun sweep(report: (Instance) -> Unit) = coroutineScope {
        val gate = Semaphore(40)
        val hosts = buildList {
            add("10.0.2.2") // Android emulator → host machine
            ownIpv4()?.let { ip -> val p = ip.split("."); if (p.size == 4) for (i in 1..254) add("${p[0]}.${p[1]}.${p[2]}.$i") }
        }
        for (h in hosts) launch(Dispatchers.IO) { gate.withPermit { confirm("http://$h:4610", "network scan")?.let(report) } }
    }

    private fun linkProps(): LinkProperties? {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return cm.getLinkProperties(cm.activeNetwork)
    }
    private fun ownIpv4(): String? = linkProps()?.linkAddresses?.firstOrNull { it.address is Inet4Address && !it.address.isLoopbackAddress }?.address?.hostAddress
    private fun subnetBroadcast(): InetAddress? {
        val la = linkProps()?.linkAddresses?.firstOrNull { it.address is Inet4Address && !it.address.isLoopbackAddress } ?: return null
        val ip = la.address.address
        val mask = if (la.prefixLength == 0) 0 else -1 shl (32 - la.prefixLength)
        val n = ((ip[0].toInt() and 255) shl 24) or ((ip[1].toInt() and 255) shl 16) or ((ip[2].toInt() and 255) shl 8) or (ip[3].toInt() and 255)
        val b = n or mask.inv()
        return InetAddress.getByAddress(byteArrayOf((b ushr 24).toByte(), (b ushr 16).toByte(), (b ushr 8).toByte(), b.toByte()))
    }
}
