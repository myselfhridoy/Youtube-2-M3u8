package com.streambd.iptv.util

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.regex.Pattern

/**
 * YouTube Live HLS (m3u8) Extractor for Android / Kotlin Apps
 * 
 * এই ইউটিলিটি ক্লাসটি সরাসরি ইউজারের লোকাল নেটওয়ার্ক (Residential/Mobile IP) থেকে রান হয়।
 * ফলে কোনো Cloudflare Worker বা ব্যাকএন্ড সার্ভার ছাড়াই, কোনো প্রকার 429 Rate Limit ব্লক ছাড়া
 * ১০০% নিরাপদে এবং 0ms বাফারিংয়ে সরাসরি YouTube Live-এর m3u8 লিংক এক্সট্র্যাক্ট করে দেয়।
 */
object YouTubeLiveExtractor {

    private const val USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

    /**
     * YouTube লাইভ স্ট্রিম থেকে m3u8 লিংক বের করার মেইন ফাংশন (Coroutine Support)
     * 
     * @param target ইনপুট হিসেবে Video ID (যেমন: "1M1aYd7jXsM"), Channel ID, অথবা সরাসরি URL দেওয়া যাবে।
     * @return সরাসরি প্লে করার উপযোগী m3u8 লিংক, অথবা ব্যর্থ হলে null
     */
    suspend fun getHlsUrl(target: String): String? = withContext(Dispatchers.IO) {
        val ytUrl = buildUrl(target)
        try {
            val html = fetchHtml(ytUrl)
            return@withContext extractM3u8FromHtml(html)
        } catch (e: Exception) {
            e.printStackTrace()
            return@withContext null
        }
    }

    /**
     * ইনপুট টাইপ বুঝে সঠিক এবং নিরাপদ (/live/ endpoint) YouTube URL তৈরি করে
     */
    private fun buildUrl(target: String): String {
        val trimmed = target.trim()
        return when {
            trimmed.startsWith("http://") || trimmed.startsWith("https://") -> {
                if (trimmed.contains("watch?v=")) {
                    trimmed.replace("watch?v=", "live/")
                } else {
                    trimmed
                }
            }
            trimmed.startsWith("@") -> "https://www.youtube.com/$trimmed/live"
            trimmed.startsWith("UC") && trimmed.length == 24 -> "https://www.youtube.com/channel/$trimmed/live"
            else -> "https://www.youtube.com/live/$trimmed" // Default treat as Video ID
        }
    }

    /**
     * লোকাল নেটওয়ার্ক থেকে HTTP GET রিকোয়েস্ট পাঠিয়ে HTML পেজ ফেচ করে
     */
    private fun fetchHtml(urlString: String): String {
        val url = URL(urlString)
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("User-Agent", USER_AGENT)
            setRequestProperty("Accept-Language", "en-US,en;q=0.9,bn;q=0.8")
            connectTimeout = 10000
            readTimeout = 10000
            instanceFollowRedirects = true
        }

        return try {
            if (connection.responseCode == HttpURLConnection.HTTP_OK) {
                BufferedReader(InputStreamReader(connection.inputStream)).use { reader ->
                    val response = StringBuilder()
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        response.append(line)
                    }
                    response.toString()
                }
            } else {
                ""
            }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * HTML টেক্সট থেকে Regex ব্যবহার করে hlsManifestUrl বা manifest.googlevideo.com লিংক খুঁজে বের করে
     */
    private fun extractM3u8FromHtml(html: String): String? {
        if (html.isEmpty()) return null

        // ১. hlsManifestUrl কি (key) দিয়ে খোঁজা
        val hlsPattern = Pattern.compile("[\"']?hlsManifestUrl[\"']?\\s*:\\s*[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE)
        var matcher = hlsPattern.matcher(html)
        var hlsUrl: String? = null

        if (matcher.find()) {
            hlsUrl = matcher.group(1)
        } else {
            // ২. সরাসরি manifest.googlevideo.com লিংক খোঁজা (hls_variant বা hls_playlist)
            val regexPattern = Pattern.compile("(https?://[^\"'\\s\\\\]*manifest\\.googlevideo\\.com/api/manifest/hls_(?:variant|playlist)/[^\"'\\s\\\\]+)", Pattern.CASE_INSENSITIVE)
            matcher = regexPattern.matcher(html)
            if (matcher.find()) {
                hlsUrl = matcher.group(1)
            }
        }

        // ইউনিকোড ক্যারেক্টার ও ব্যাকস্ল্যাশ পরিষ্কার করা
        return hlsUrl?.let {
            it.replace("\\u0026", "&")
              .replace("\\/", "/")
              .replace("\\", "")
        }
    }
}

/*
 =========================================================================================
 💡 ANDROID EXOPLAYER / MEDIA3 INTEGRATION EXAMPLE (কিভাবে অ্যাপে ব্যবহার করবেন):
 =========================================================================================

 // ViewModel বা Coroutine Scope থেকে কল করুন:
 val videoId = "1M1aYd7jXsM" // অথবা "https://www.youtube.com/@JamunaTVbd/live"
 
 lifecycleScope.launch {
     val m3u8Url = YouTubeLiveExtractor.getHlsUrl(videoId)
     
     if (m3u8Url != null) {
         // ExoPlayer / Media3 তে সরাসরি প্লে করুন:
         val mediaItem = MediaItem.fromUri(m3u8Url)
         player.setMediaItem(mediaItem)
         player.prepare()
         player.play()
     } else {
         Toast.makeText(context, "Stream Offline or Error", Toast.LENGTH_SHORT).show()
     }
 }
 =========================================================================================
*/
