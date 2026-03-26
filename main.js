require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const COUNTRY = require("./lib/country.json");
const { fetchAllRegions, findArtistRanksCustom } = require("./lib/scraper");
const { createClient } = require("@supabase/supabase-js");
const express = require("express"); // ✅ TAMBAHAN

const app = express(); // ✅ TAMBAHAN
app.use(express.json()); // ✅ TAMBAHAN

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error("BOT_TOKEN is not set in .env");
  process.exit(1);
}

// ❌ HAPUS polling
// const bot = new TelegramBot(token, { polling: true });

// ✅ GANTI webhook mode
const bot = new TelegramBot(token);

// ✅ SUPABASE INIT
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

let cachedRegionData = null;
let cacheTime = 0;
let loadingPromise = null;

const CACHE_TTL = 60 * 60 * 1000;

const EXTENDED_TOP_REGIONS = new Set([
  "Germany",
  "Brazil",
  "USA",
  "UK",
  "Canada",
  "France",
  "Australia",
  "Japan",
]);

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

function parseQuery(input) {
  const text = String(input || "").trim();
  const parts = text.split(" - ").map((x) => x.trim()).filter(Boolean);

  if (parts.length !== 2) return null;

  const [title, artist] = parts;

  if (!title || !artist) return null;

  return {
    title,
    artist,
    raw: `${title} - ${artist}`,
  };
}

function getCountryMeta(regionName) {
  const data = COUNTRY[regionName];

  if (!data) {
    return {
      name: regionName,
      flag: "",
    };
  }

  const flag = String(data.code || "")
    .toUpperCase()
    .split("")
    .map((char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join("");

  return {
    name: data.name || regionName,
    flag,
  };
}

async function getRegionData() {
  const now = Date.now();

  if (cachedRegionData && now - cacheTime < CACHE_TTL) {
    log("⚡ Using cached region data");
    return cachedRegionData;
  }

  if (loadingPromise) {
    log("⏳ Waiting for the current fetch process...");
    return loadingPromise;
  }

  loadingPromise = (async () => {
    try {
      log("🚀 Starting fetch for all regions...");
      const start = Date.now();

      const data = await fetchAllRegions(10);

      const success = data.filter((x) => x.success).length;
      const failed = data.length - success;

      log(`✅ Fetch completed | success: ${success} | failed: ${failed}`);
      log(`⏱ Duration: ${(Date.now() - start) / 1000}s`);

      cachedRegionData = data;
      cacheTime = Date.now();

      return data;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

function formatResults(query, results) {
  if (!results.length) {
    return `🎵 ${query}\n\nNo results found for the selected region filters.`;
  }

  const topRegions = [];
  const otherRegions = [];

  for (const item of results) {
    if (EXTENDED_TOP_REGIONS.has(item.region)) {
      topRegions.push(item);
    } else {
      otherRegions.push(item);
    }
  }

  topRegions.sort((a, b) => a.rank - b.rank || a.region.localeCompare(b.region));
  otherRegions.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.region.localeCompare(b.region);
  });

  const bestMatch = results[0];
  const displayTitle =
    bestMatch.fullText ||
    `${bestMatch.artist || ""} - ${bestMatch.title || ""}`.trim() ||
    query;

  const rank1Count = results.filter((x) => x.rank === 1).length;
  const totalCount = results.length;

  const lines = [
    `🎵 ${displayTitle}`,
    "",
    `#1 in ${rank1Count} countr${rank1Count === 1 ? "y" : "ies"}`,
    `Found in ${totalCount} countr${totalCount === 1 ? "y" : "ies"}`,
    "",
  ];

  if (topRegions.length) {
    lines.push("🌍 Main Regions (Top 100)");
    for (const item of topRegions) {
      const meta = getCountryMeta(item.region);
      const label = meta.flag ? `${meta.name} ${meta.flag}` : meta.name;
      lines.push(`${label} — #${item.rank}`);
    }
    lines.push("");
  }

  if (otherRegions.length) {
    lines.push("🏁 Other Regions (#1 only)");
    for (const item of otherRegions) {
      const meta = getCountryMeta(item.region);
      const label = meta.flag ? `${meta.name} ${meta.flag}` : meta.name;
      lines.push(`${label} — #${item.rank}`);
    }
  }

  return lines.join("\n").trim();
}

// ✅ TRACKING
async function checkAndSaveNumberOne(song, artist, results) {
  const newOnes = [];
  const alreadyOnes = [];

  for (const item of results) {
    if (item.rank !== 1) continue;

    try {
      const { data } = await supabase
        .from("songs")
        .select("*")
        .eq("title", song)
        .eq("artist", artist);

      if (data && data.length > 0) {
        alreadyOnes.push(item.region);
      } else {
        newOnes.push(item.region);

        await supabase.from("songs").insert([
          {
            title: song,
            artist: artist,
          },
        ]);
      }
    } catch (err) {
      console.error("Supabase error:", err.message);
    }
  }

  return { newOnes, alreadyOnes };
}

function splitMessage(text, maxLength = 3500) {
  const chunks = [];
  let current = "";

  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;

    if (next.length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

// ✅ START COMMAND
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    "Hello, please use format:\nTitle - Artist"
  );
});

// ✅ MESSAGE HANDLER
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (!text || text.startsWith("/")) return;

  const parsed = parseQuery(text);

  if (!parsed) {
    await bot.sendMessage(chatId, "Use format:\nTitle - Artist");
    return;
  }

  try {
    const progressMessage = await bot.sendMessage(chatId, "⏳ Searching...");

    const allRegionData = await getRegionData();

    const results = findArtistRanksCustom(allRegionData, parsed, {
      extendedTopRegions: EXTENDED_TOP_REGIONS,
      defaultTopLimit: 1,
      extendedTopLimit: 100,
      exact: false,
      firstOnly: true,
    });

    const { newOnes, alreadyOnes } = await checkAndSaveNumberOne(
      parsed.title,
      parsed.artist,
      results
    );

    let message = formatResults(parsed.raw, results);

    if (newOnes.length) {
      message += `\n\n🚨 NEW #1 in ${newOnes.length} countries`;
    }

    if (alreadyOnes.length) {
      message += `\n🔥 Already #1 before`;
    }

    await bot.deleteMessage(chatId, String(progressMessage.message_id));

    const chunks = splitMessage(message);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, "Error occurred.");
  }
});

// ✅ WEBHOOK ROUTE (INI YANG PENTING)
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ✅ PORT (BIAR RENDER GA ERROR)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Webhook server running on port", PORT);
});
