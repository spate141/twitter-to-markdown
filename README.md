# Twitter/X to Markdown — Chrome Extension

Scrape any Twitter/X conversation (tweet + all replies) and convert it into clean, structured Markdown.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `twitter-to-markdown` folder
5. The extension icon will appear in your toolbar

## Usage

1. Navigate to any tweet on **x.com** or **twitter.com**
2. Click the extension icon in the toolbar
3. Choose:
   - **📜 Scroll & Scrape All** — auto-scrolls the entire page to load all replies, then parses everything
   - **⚡ Scrape Visible** — instantly grabs only the tweets currently loaded in the DOM (no scrolling)
4. Once done, you can:
   - **📋 Copy** the Markdown to clipboard
   - **💾 .md** to download as a `.md` file

## Output Format

The generated Markdown includes:

- **Header** with source URL, capture timestamp, and tweet count
- **Original tweet** as `##` heading with author, handle, timestamp (linked), and full text
- **Replies** as `###` headings
- **Quoted tweets** rendered as blockquotes
- **Media markers** (📷 Image, 🎥 Video)
- **Engagement metrics** (replies, reposts, likes, bookmarks, views)
- **Rich text** — hashtags and mentions bolded, links expanded from t.co

## Notes

- Twitter loads replies lazily, so "Scroll & Scrape All" is needed for full threads
- You can **stop** scrolling at any time
- Duplicate tweets are automatically de-duplicated
- The extension only runs on twitter.com, x.com, and mobile.twitter.com
