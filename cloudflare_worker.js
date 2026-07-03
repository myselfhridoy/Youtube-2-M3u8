/**
 * Cloudflare Worker - YouTube Live M3U8 Smart Redirector with Cache & Anti-429
 * 
 * এই স্ক্রিপ্টটি Cloudflare-এর ঢাকা (Dhaka BDIX) সার্ভার থেকে সরাসরি YouTube Live-এর 
 * ফ্রেশ m3u8 লিংক ফেচ করে এবং ইন-মেমোরি ক্যাশ (Cache) করে রাখে, যেন বারবার রিকোয়েস্টে 
 * YouTube IP ব্লক (429 Rate Limit) না করে।
 */

// গ্লোবাল ইন-মেমোরি ক্যাশ (Cloudflare Edge-এ ১০ মিনিট পর্যন্ত লিংক সেভ থাকবে)
const hlsCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("v") || url.searchParams.get("id");
    const channelId = url.searchParams.get("c") || url.searchParams.get("channel");
    const targetUrl = url.searchParams.get("url");
    const isDebug = url.searchParams.get("debug") === "1";
    const noCache = url.searchParams.get("nocache") === "1";

    if (!videoId && !channelId && !targetUrl) {
      return new Response(
        "📺 YouTube Live M3U8 Smart Proxy Worker is Running!\n\nUsage:\n  /?v=VIDEO_ID\n  /?c=CHANNEL_ID\n  /?url=YOUTUBE_LIVE_URL\n  Add &debug=1 for troubleshooting\n  Add &nocache=1 to force bypass cache",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" } }
      );
    }

    // একটি ইউনিক ক্যাশ কী তৈরি করা
    const cacheKey = videoId || channelId || targetUrl;

    // ১. ক্যাশ চেক করা (যদি ক্যাশ থাকে এবং ১০ মিনিটের কম পুরনো হয়, তবে কোনো নেটওয়ার্ক কল ছাড়াই রিডাইরেক্ট করবে!)
    if (!noCache && !isDebug && hlsCache.has(cacheKey)) {
      const cachedData = hlsCache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < CACHE_TTL_MS) {
        return Response.redirect(cachedData.url, 302);
      }
    }

    let ytUrl = "";
    if (videoId) {
      ytUrl = `https://www.youtube.com/live/${videoId}`;
    } else if (channelId) {
      ytUrl = `https://www.youtube.com/channel/${channelId}/live`;
    } else if (targetUrl) {
      ytUrl = targetUrl;
      if (ytUrl.includes("watch?v=")) {
        ytUrl = ytUrl.replace("watch?v=", "live/");
      }
    }

    try {
      // ২. প্রথম চেষ্টা: স্ট্যান্ডার্ড ডেস্কটপ ব্রাউজার
      let response = await fetch(ytUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          "Cookie": "CONSENT=YES+cb.20230531-04-p0.en+FX+111; SOCS=CAI;",
        },
        redirect: "follow",
      });

      let html = await response.text();
      let hlsUrl = extractHls(html);

      // ৩. যদি 429 (Rate Limit) বা লিংক না পায়, তবে দ্বিতীয় চেষ্টা: মোবাইল ওয়েব (m.youtube.com) ও iOS User-Agent
      if (!hlsUrl || response.status === 429 || response.url.includes("consent") || response.url.includes("sorry")) {
        const mobileUrl = ytUrl.replace("www.youtube.com", "m.youtube.com");
        response = await fetch(mobileUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
        });
        html = await response.text();
        hlsUrl = extractHls(html);
      }

      // ৪. যদি এখনও না পায়, তবে তৃতীয় চেষ্টা: Googlebot (কোনো কুকি ছাড়া)
      if (!hlsUrl || response.status === 429 || response.url.includes("consent") || response.url.includes("sorry")) {
        response = await fetch(ytUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
        });
        html = await response.text();
        hlsUrl = extractHls(html);
      }

      if (hlsUrl) {
        // সফলভাবে পেলে ক্যাশে সেভ করা হলো (১০ মিনিটের জন্য)
        hlsCache.set(cacheKey, {
          url: hlsUrl,
          timestamp: Date.now(),
        });

        if (isDebug) {
          return new Response(`✅ Found HLS URL:\n${hlsUrl}\n\nFetched from: ${ytUrl}\nStatus: ${response.status}\nCached for 10 mins`, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
          });
        }

        return Response.redirect(hlsUrl, 302);
      }

      // যদি সব চেষ্টায় ব্যর্থ হয় কিন্তু পুরনো ক্যাশ থাকে, তবে সেই পুরনো ক্যাশ লিংক পাঠিয়ে দেবে (কারণ m3u8 লিংক ৬ ঘণ্টা কাজ করে!)
      if (hlsCache.has(cacheKey)) {
        const fallbackCache = hlsCache.get(cacheKey);
        if (isDebug) {
          return new Response(`⚠️ Using Stale Cache due to 429/error:\n${fallbackCache.url}`, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
          });
        }
        return Response.redirect(fallbackCache.url, 302);
      }

      if (isDebug) {
        return new Response(
          `❌ Debug Info:\nTarget: ${ytUrl}\nHTTP Status: ${response.status}\nURL after redirect: ${response.url}\n\nHTML Snippet (first 1000 chars):\n${html.substring(0, 1000)}`,
          { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
        }
        );
      }

      return new Response("❌ Error: Channel is offline or stream HLS manifest not found.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    } catch (err) {
      if (hlsCache.has(cacheKey)) {
        return Response.redirect(hlsCache.get(cacheKey).url, 302);
      }
      return new Response(`❌ Worker Fetch Error: ${err.message}`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};

// HTML থেকে m3u8 লিংক বের করার সহায়ক ফাংশন
function extractHls(html) {
  if (!html) return "";
  let hlsUrl = "";
  const hlsMatch = html.match(/["']?hlsManifestUrl["']?\s*:\s*["']([^"']+)["']/i);
  if (hlsMatch && hlsMatch[1]) {
    hlsUrl = hlsMatch[1];
  } else {
    const regexMatch = html.match(/(https?:\/\/[^"'\s\\]*manifest\.googlevideo\.com\/api\/manifest\/hls_(?:variant|playlist)\/[^"'\s\\]+)/i);
    if (regexMatch && regexMatch[1]) {
      hlsUrl = regexMatch[1];
    }
  }
  if (hlsUrl) {
    hlsUrl = hlsUrl
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");
  }
  return hlsUrl;
}
