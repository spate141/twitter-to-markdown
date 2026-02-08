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
   * Extract author handle from tweet URL
   * URL format: https://x.com/username/status/123456
   */
  function extractAuthorFromUrl(url) {
    const match = url.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status\//);
    return match ? '@' + match[1] : null;
  }

  /**
   * Scroll the page to the bottom, waiting for new content to load.
   * Collects tweets incrementally as the page scrolls to avoid losing
   * tweets to DOM virtualization.
   * Returns array of collected tweets.
   */
  async function autoScroll(signal, onProgress) {
    const MAX_IDLE_ATTEMPTS = 15;  // 37.5 seconds idle time
    const SCROLL_DELAY = 2500;     // 2.5 seconds for Twitter's lazy-loading
    let idleCount = 0;
    let lastHeight = document.body.scrollHeight;
    let scrollCycles = 0;
    const tweetMap = new Map();    // Map for O(1) deduplication

    // Collect currently visible tweets FIRST (before any scroll)
    // This captures the main tweet and any initially visible replies
    let tweetEls = document.querySelectorAll(SEL.tweet);
    tweetEls.forEach((el) => {
      try {
        const tweet = parseTweet(el);
        const key = `${tweet.handle}::${(tweet.text || "").slice(0, 80)}`;
        if (!tweetMap.has(key)) {
          tweetMap.set(key, tweet);
        }
      } catch (e) {
        console.warn("[TwMD] Failed to parse tweet on initial load:", e);
      }
    });

    // Report initial collection
    if (onProgress) onProgress(tweetMap.size, 0);

    // Now scroll to load additional tweets
    while (idleCount < MAX_IDLE_ATTEMPTS) {
      if (signal?.aborted) {
        // Return partial collection on abort
        return Array.from(tweetMap.values());
      }

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

      // Collect newly-appeared tweets
      tweetEls = document.querySelectorAll(SEL.tweet);
      tweetEls.forEach((el) => {
        try {
          const tweet = parseTweet(el);
          const key = `${tweet.handle}::${(tweet.text || "").slice(0, 80)}`;
          if (!tweetMap.has(key)) {
            tweetMap.set(key, tweet);
          }
        } catch (e) {
          console.warn("[TwMD] Failed to parse tweet during scroll:", e);
        }
      });

      // Check for spam indicator (stop auto-scroll if detected)
      const bodyText = document.body.textContent || "";
      if (bodyText.includes("Show probable spam") ||
          bodyText.includes("Show hidden replies") ||
          bodyText.includes("Show additional replies")) {
        console.log("[TwMD] Spam indicator detected. Stopping scroll.");

        // Return with spam_detected notification
        const tweets = Array.from(tweetMap.values());
        const markdown = tweetsToMarkdown(tweets, window.location.href);

        notifyPopup({
          type: "spam_detected",
          markdown,
          count: tweets.length,
        });

        return tweets;
      }

      if (onProgress) onProgress(tweetMap.size, scrollCycles);
    }

    // Return collected tweets (no scroll back to top)
    return Array.from(tweetMap.values());
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

    // -- Replying to context --
    let replyingTo = null;
    const socialContextEl = el.querySelector(SEL.socialContext);
    if (socialContextEl) {
      const contextText = socialContextEl.textContent || "";
      // Extract handles from "Replying to @user1 @user2"
      const handleMatches = contextText.match(/@[A-Za-z0-9_]+/g);
      if (handleMatches && handleMatches.length > 0) {
        replyingTo = handleMatches; // Array like ["@user1", "@user2"]
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

    return {
      displayName,
      handle,
      timestamp,
      tweetUrl,
      replyingTo,
      text: textMd,
      quotedTweet,
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

  /**
   * Render a single tweet to markdown lines.
   * @param {Object} t - Tweet object
   * @param {string} heading - Heading level ("##" or "###")
   * @param {Array} lines - Array to append markdown lines to
   * @param {boolean} isOpReply - Whether this is the OP replying in replies section
   */
  function renderTweet(t, heading, lines, isOpReply = false) {
    const author = t.displayName
      ? `${t.displayName} (${t.handle})`
      : t.handle || "Unknown";

    // Add author indicator for OP replies in the replies section
    const opIndicator = isOpReply ? " 👤 **Author's Reply**" : "";

    lines.push(`${heading} ${author}${opIndicator}`);

    // Timestamp with link if available
    if (t.timestamp) {
      if (t.tweetUrl) {
        lines.push(`*[${formatTimestamp(t.timestamp)}](${t.tweetUrl})*`);
      } else {
        lines.push(`*${formatTimestamp(t.timestamp)}*`);
      }
    }

    // "Replying to" context (if present)
    if (t.replyingTo && t.replyingTo.length > 0) {
      lines.push(`*Replying to ${t.replyingTo.join(" ")}*`);
    }

    lines.push(``);

    // Tweet body
    if (t.text) {
      lines.push(t.text);
      lines.push(``);
    }

    // Quoted tweet (as blockquote with attribution)
    if (t.quotedTweet) {
      lines.push(`> **Quoting ${t.quotedTweet.author || ""}:**`);
      t.quotedTweet.text
        .split("\n")
        .forEach((l) => lines.push(`> ${l}`));
      lines.push(``);
    }
  }

  /**
   * Convert an array of parsed tweets into a Markdown document.
   */
  function tweetsToMarkdown(tweets, pageUrl) {
    const lines = [];

    if (tweets.length === 0) return "";

    // Extract original poster from URL
    const opHandle = extractAuthorFromUrl(pageUrl);

    // Find the index of the first OP tweet (the main tweet)
    let mainTweetIndex = -1;
    if (opHandle) {
      mainTweetIndex = tweets.findIndex(t => t.handle === opHandle);
    }
    if (mainTweetIndex === -1) mainTweetIndex = 0; // Fallback to first tweet

    // -- Render the main tweet --
    const mainTweet = tweets[mainTweetIndex];
    renderTweet(mainTweet, "##", lines, false);

    // Get remaining tweets (everything after the main tweet, in order)
    const remainingTweets = tweets.slice(mainTweetIndex + 1);

    // -- Add visual separator if there are replies --
    if (remainingTweets.length > 0) {
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
      lines.push(`## 💬 Replies`);
      lines.push(``);
    }

    // -- Render all remaining tweets in chronological order --
    remainingTweets.forEach((t) => {
      // Check if this is the OP replying in the thread
      const isOpReply = (t.handle === opHandle);
      renderTweet(t, "###", lines, isOpReply);
    });

    return lines.join("\n");
  }

  // ── Main orchestration ─────────────────────────────────────

  async function scrapeAndConvert() {
    abortController = new AbortController();
    isScrolling = true;

    try {
      // Notify popup of start
      notifyPopup({ type: "progress", message: "Starting scroll…", count: 0 });

      // Always scroll and collect tweets
      const tweets = await autoScroll(abortController.signal, (uniqueCount, cycles) => {
        notifyPopup({
          type: "progress",
          message: `Scrolling… ${uniqueCount} unique tweets captured (pass ${cycles})`,
          count: uniqueCount,
        });
      }) || [];

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
