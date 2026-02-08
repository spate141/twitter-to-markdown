// =============================================================
// Twitter/X to Markdown — Content Script
// =============================================================

(() => {
  "use strict";

  // ── State ──────────────────────────────────────────────────
  let isScrolling = false;
  let abortController = null;

  // ── DOM Selectors (Twitter data-testid based) ──────────────
  const SEL = {
    tweet: '[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    userName: '[data-testid="User-Name"]',
    socialContext: '[data-testid="socialContext"]',
    card: '[data-testid="card.wrapper"]',
    tweetPhoto: '[data-testid="tweetPhoto"]',
    videoPlayer: '[data-testid="videoPlayer"]',
  };

  // ── Utility helpers ────────────────────────────────────────

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Scroll the page to the bottom, waiting for new content to load.
   * Resolves when no new content appears after several attempts.
   */
  async function autoScroll(signal, onProgress) {
    const MAX_IDLE_ATTEMPTS = 5;
    const SCROLL_DELAY = 1200;
    let idleCount = 0;
    let lastHeight = document.body.scrollHeight;
    let scrollCycles = 0;

    while (idleCount < MAX_IDLE_ATTEMPTS) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      window.scrollTo(0, document.body.scrollHeight);
      await sleep(SCROLL_DELAY);
      scrollCycles++;

      const newHeight = document.body.scrollHeight;
      if (newHeight === lastHeight) {
        idleCount++;
      } else {
        idleCount = 0;
        lastHeight = newHeight;
      }

      const tweets = document.querySelectorAll(SEL.tweet);
      if (onProgress) onProgress(tweets.length, scrollCycles);
    }

    // Scroll back to top after collection
    window.scrollTo(0, 0);
  }

  // ── Tweet Parsing ──────────────────────────────────────────

  /**
   * Extract structured data from a single tweet DOM element.
   */
  function parseTweet(el) {
    // -- Username & display name --
    const userNameEl = el.querySelector(SEL.userName);
    let displayName = "";
    let handle = "";
    let timestamp = "";
    let tweetUrl = "";

    if (userNameEl) {
      // Display name is usually the first text-bearing span
      const nameSpans = userNameEl.querySelectorAll(
        'a[role="link"] span:not([aria-hidden])'
      );
      if (nameSpans.length) {
        displayName = nameSpans[0]?.textContent?.trim() || "";
      }

      // Handle (@username)
      const links = userNameEl.querySelectorAll('a[role="link"]');
      for (const link of links) {
        const href = link.getAttribute("href") || "";
        if (href.match(/^\/[A-Za-z0-9_]+$/) && !handle) {
          handle = "@" + href.slice(1);
        }
      }

      // Timestamp from <time> element
      const timeEl = userNameEl.querySelector("time") || el.querySelector("time");
      if (timeEl) {
        timestamp = timeEl.getAttribute("datetime") || timeEl.textContent || "";
        // Get tweet URL from the time element's parent link
        const timeLink = timeEl.closest("a");
        if (timeLink) {
          tweetUrl = timeLink.getAttribute("href") || "";
          if (tweetUrl && !tweetUrl.startsWith("http")) {
            tweetUrl = "https://x.com" + tweetUrl;
          }
        }
      }
    }

    // -- Tweet text (rich) --
    const tweetTextEl = el.querySelector(SEL.tweetText);
    let textMd = "";
    if (tweetTextEl) {
      textMd = htmlNodeToMarkdown(tweetTextEl);
    }

    // -- Quoted tweet --
    let quotedTweet = null;
    const quotedEl = el.querySelector('[aria-labelledby]');
    if (quotedEl && quotedEl !== el) {
      const qText = quotedEl.querySelector(SEL.tweetText);
      const qUser = quotedEl.querySelector(SEL.userName);
      if (qText) {
        quotedTweet = {
          author: qUser?.textContent?.trim() || "",
          text: htmlNodeToMarkdown(qText),
        };
      }
    }

    // -- Media detection --
    const hasPhoto = !!el.querySelector(SEL.tweetPhoto);
    const hasVideo = !!el.querySelector(SEL.videoPlayer);

    // -- Engagement metrics --
    const metrics = extractMetrics(el);

    return {
      displayName,
      handle,
      timestamp,
      tweetUrl,
      text: textMd,
      quotedTweet,
      hasPhoto,
      hasVideo,
      metrics,
    };
  }

  /**
   * Convert a tweet-text HTML node into Markdown, handling
   * links, hashtags, mentions, bold, italic, etc.
   */
  function htmlNodeToMarkdown(node) {
    let md = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        md += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();

        if (tag === "a") {
          const href = child.getAttribute("href") || "";
          const text = child.textContent?.trim() || "";
          // Hashtag or mention — keep as-is
          if (text.startsWith("#") || text.startsWith("@")) {
            md += `**${text}**`;
          } else if (href) {
            // Expand t.co links using the title or visible text
            const expanded = child.getAttribute("title") || text;
            const fullHref = href.startsWith("http")
              ? href
              : href.startsWith("/")
                ? "https://x.com" + href
                : href;
            if (expanded && expanded !== "…" && expanded !== fullHref) {
              md += `[${expanded}](${fullHref})`;
            } else {
              md += fullHref;
            }
          } else {
            md += text;
          }
        } else if (tag === "img") {
          // Emoji images
          const alt = child.getAttribute("alt") || "";
          md += alt;
        } else if (tag === "span" || tag === "div") {
          md += htmlNodeToMarkdown(child);
        } else if (tag === "strong" || tag === "b") {
          md += `**${htmlNodeToMarkdown(child)}**`;
        } else if (tag === "em" || tag === "i") {
          md += `*${htmlNodeToMarkdown(child)}*`;
        } else if (tag === "br") {
          md += "\n";
        } else {
          md += htmlNodeToMarkdown(child);
        }
      }
    }
    return md;
  }

  /**
   * Try to grab engagement numbers (likes, retweets, replies, views).
   */
  function extractMetrics(el) {
    const metrics = {};
    const groups = el.querySelectorAll('[role="group"] button[data-testid]');
    for (const btn of groups) {
      const testId = btn.getAttribute("data-testid") || "";
      const ariaLabel = btn.getAttribute("aria-label") || "";
      // aria-label is like "245 Likes" or "12 replies"
      const match = ariaLabel.match(/^([\d,.]+[KMB]?)\s+(.+)/i);
      if (match) {
        const value = match[1];
        const type = match[2].toLowerCase();
        if (type.includes("repl")) metrics.replies = value;
        else if (type.includes("repost") || type.includes("retweet"))
          metrics.reposts = value;
        else if (type.includes("like")) metrics.likes = value;
        else if (type.includes("bookmark")) metrics.bookmarks = value;
        else if (type.includes("view")) metrics.views = value;
      }
    }
    return metrics;
  }

  // ── Markdown Rendering ─────────────────────────────────────

  function formatTimestamp(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      if (isNaN(d)) return ts;
      return d.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return ts;
    }
  }

  function metricsLine(m) {
    const parts = [];
    if (m.replies) parts.push(`💬 ${m.replies}`);
    if (m.reposts) parts.push(`🔁 ${m.reposts}`);
    if (m.likes) parts.push(`❤️ ${m.likes}`);
    if (m.bookmarks) parts.push(`🔖 ${m.bookmarks}`);
    if (m.views) parts.push(`👁️ ${m.views}`);
    return parts.length ? parts.join("  ·  ") : "";
  }

  /**
   * Convert an array of parsed tweets into a Markdown document.
   */
  function tweetsToMarkdown(tweets, pageUrl) {
    const lines = [];
    const now = new Date().toISOString();

    // Header
    lines.push(`# Twitter/X Conversation`);
    lines.push(``);
    if (pageUrl) lines.push(`> Source: ${pageUrl}`);
    lines.push(`> Captured: ${formatTimestamp(now)}`);
    lines.push(`> Tweets: ${tweets.length}`);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);

    // Determine the "main" tweet (first one, usually the OP)
    const isFirst = (i) => i === 0;

    tweets.forEach((t, i) => {
      // Heading level: first tweet = ##, replies = ###
      const heading = isFirst(i) ? "##" : "###";
      const author = t.displayName
        ? `${t.displayName} (${t.handle})`
        : t.handle || "Unknown";

      lines.push(`${heading} ${author}`);
      if (t.timestamp) {
        const linkPart = t.tweetUrl
          ? `[${formatTimestamp(t.timestamp)}](${t.tweetUrl})`
          : formatTimestamp(t.timestamp);
        lines.push(`*${linkPart}*`);
      }
      lines.push(``);

      // Tweet body
      if (t.text) {
        lines.push(t.text);
        lines.push(``);
      }

      // Quoted tweet
      if (t.quotedTweet) {
        lines.push(`> **Quoting ${t.quotedTweet.author || ""}:**`);
        t.quotedTweet.text
          .split("\n")
          .forEach((l) => lines.push(`> ${l}`));
        lines.push(``);
      }

      // Media markers
      const media = [];
      if (t.hasPhoto) media.push("📷 *Image*");
      if (t.hasVideo) media.push("🎥 *Video*");
      if (media.length) {
        lines.push(media.join("  "));
        lines.push(``);
      }

      // Metrics
      const ml = metricsLine(t.metrics);
      if (ml) {
        lines.push(`<sub>${ml}</sub>`);
        lines.push(``);
      }

      lines.push(`---`);
      lines.push(``);
    });

    return lines.join("\n");
  }

  // ── Deduplication ──────────────────────────────────────────

  function dedupeTweets(tweets) {
    const seen = new Set();
    return tweets.filter((t) => {
      // Key on handle + first 80 chars of text
      const key = `${t.handle}::${(t.text || "").slice(0, 80)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ── Main orchestration ─────────────────────────────────────

  async function scrapeAndConvert(options = {}) {
    const { scrollAll = true } = options;

    abortController = new AbortController();
    isScrolling = true;

    try {
      // Notify popup of start
      notifyPopup({ type: "progress", message: "Starting scroll…", count: 0 });

      if (scrollAll) {
        await autoScroll(abortController.signal, (count, cycles) => {
          notifyPopup({
            type: "progress",
            message: `Scrolling… ${count} tweets found (pass ${cycles})`,
            count,
          });
        });
      }

      notifyPopup({ type: "progress", message: "Parsing tweets…" });

      // Collect all tweet elements
      const tweetEls = document.querySelectorAll(SEL.tweet);
      let tweets = [];
      tweetEls.forEach((el) => {
        try {
          tweets.push(parseTweet(el));
        } catch (e) {
          console.warn("[TwMD] Failed to parse tweet:", e);
        }
      });

      tweets = dedupeTweets(tweets);

      const markdown = tweetsToMarkdown(tweets, window.location.href);

      notifyPopup({
        type: "result",
        markdown,
        count: tweets.length,
      });

      return markdown;
    } catch (e) {
      if (e.name === "AbortError") {
        notifyPopup({ type: "aborted" });
      } else {
        notifyPopup({ type: "error", message: e.message });
      }
    } finally {
      isScrolling = false;
      abortController = null;
    }
  }

  /**
   * Quick scrape — no scrolling, just grab what's visible.
   */
  async function scrapeVisible() {
    return scrapeAndConvert({ scrollAll: false });
  }

  function stopScrolling() {
    if (abortController) abortController.abort();
  }

  // ── Communication with popup ───────────────────────────────

  function notifyPopup(data) {
    chrome.runtime.sendMessage(data).catch(() => {
      // popup might be closed — that's fine
    });
  }

  // Listen for commands from the popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "scrape_all") {
      scrapeAndConvert();
      sendResponse({ ok: true });
    } else if (msg.action === "scrape_visible") {
      scrapeVisible();
      sendResponse({ ok: true });
    } else if (msg.action === "stop") {
      stopScrolling();
      sendResponse({ ok: true });
    } else if (msg.action === "ping") {
      sendResponse({ ok: true, isScrolling });
    }
    return true; // keep channel open for async
  });

  console.log("[Twitter-to-Markdown] Content script loaded.");
})();
