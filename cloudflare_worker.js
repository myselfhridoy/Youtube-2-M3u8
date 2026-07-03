/**
 * Cloudflare Worker - YouTube Live M3U8 Smart Redirector
 * 
 * এই স্ক্রিপ্টটি Cloudflare-এর ঢাকা (Dhaka BDIX) সার্ভার থেকে সরাসরি YouTube Live-এর 
 * ফ্রেশ m3u8 লিংক ফেচ করে দেয়, ফলে বাংলাদেশে কোনো 403 এরর বা বাফারিং হয় না।
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("v") || url.searchParams.get("id");
    const channelId = url.searchParams.get("c") || url.searchParams.get("channel");
    const targetUrl = url.searchParams.get("url");
    const isDebug = url.searchParams.get("debug") === "1";

    if (!videoId && !channelId && !targetUrl) {
      return new Response(
        "📺 YouTube Live M3U8 Smart Proxy Worker is Running!\n\nUsage:\n  /?v=VIDEO_ID\n  /?c=CHANNEL_ID\n  /?url=YOUTUBE_LIVE_URL\n  Add &debug=1 for troubleshooting",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" } }
      );
    }

    let ytUrl = "";
    if (videoId) {
      ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    } else if (channelId) {
      ytUrl = `https://www.youtube.com/channel/${channelId}/live`;
    } else if (targetUrl) {
      ytUrl = targetUrl;
    }

    try {
      // প্রথম চেষ্টা: সাধারণ ক্লিন হেডার দিয়ে ফেচ করা (বট সন্দেহ বা 429 এড়াতে কোনো পুরনো স্ট্যাটিক কুকি ছাড়া)
      let response = await fetch(ytUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9,bn;q=0.8",
        },
        redirect: "follow",
      });

      // যদি YouTube থেকে 429 (Rate Limit / CAPTCHA) বা Consent পেজ দেয়, তবে Googlebot User-Agent দিয়ে রিট্রাই করবে
      if (response.status === 429 || response.url.includes("consent.youtube.com") || response.url.includes("sorry/index")) {
        response = await fetch(ytUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "Accept-Language": "en-US,en;q=0.9",
            "Cookie": "SOCS=CAI;",
          },
          redirect: "follow",
        });
      }

      const html = await response.text();

      // HTML পেজ থেকে hlsManifestUrl বা manifest.googlevideo.com লিংক বের করা
      let hlsUrl = "";
      const hlsMatch = html.match(/["']?hlsManifestUrl["']?\s*:\s*["']([^"']+)["']/i);
      if (hlsMatch && hlsMatch[1]) {
        hlsUrl = hlsMatch[1];
      } else {
        // ব্যাকআপ চেক: যেকোনো manifest.googlevideo.com লিংক (hls_variant বা hls_playlist উভয়ই)
        const regexMatch = html.match(/(https?:\/\/[^"'\s\\]*manifest\.googlevideo\.com\/api\/manifest\/hls_(?:variant|playlist)\/[^"'\s\\]+)/i);
        if (regexMatch && regexMatch[1]) {
          hlsUrl = regexMatch[1];
        }
      }

      if (hlsUrl) {
        // ইউনিকোড ও ব্যাকস্ল্যাশ পরিষ্কার করা
        hlsUrl = hlsUrl
          .replace(/\\u0026/g, "&")
          .replace(/\\\//g, "/")
          .replace(/\\/g, "");

        if (isDebug) {
          return new Response(`✅ Found HLS URL:\n${hlsUrl}\n\nFetched from: ${ytUrl}\nStatus: ${response.status}`, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
          });
        }

        // প্লেয়ারকে সরাসরি লোকালে ফেচ করা লিংকে রিডাইরেক্ট করা (HTTP 302)
        return Response.redirect(hlsUrl, 302);
      }

      if (isDebug) {
        return new Response(
          `❌ Debug Info:\nTarget: ${ytUrl}\nHTTP Status: ${response.status}\nURL after redirect: ${response.url}\n\nHTML Snippet (first 1000 chars):\n${html.substring(0, 1000)}`,
          { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" } }
        );
      }

      return new Response("❌ Error: Channel is offline or stream HLS manifest not found.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    } catch (err) {
      return new Response(`❌ Worker Fetch Error: ${err.message}`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};
