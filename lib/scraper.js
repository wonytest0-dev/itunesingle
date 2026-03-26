const axios = require("axios");
const cheerio = require("cheerio");
const REGIONS = require("./regions.json");

const BASE_URL = "http://www.digitalsalesdata.com/diydsd.php";

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchRegion(regionId, regionName) {
  try {
    const response = await axios.get(BASE_URL, {
      params: { Region: regionId },
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Encoding": "gzip, deflate",
      },
      timeout: 20000,
    });

    const $ = cheerio.load(response.data);
    const rows = [];

    $("table tr").each((_, tr) => {
      const tds = $(tr).find("td");

      if (tds.length === 4) {
        const rank = $(tds[0]).text().trim();
        const artist = $(tds[1]).text().trim();
        const title = $(tds[2]).text().trim();
        const sales = $(tds[3]).text().trim();

        if (/^\d+$/.test(rank)) {
          rows.push({
            rank: Number(rank),
            artist,
            title,
            fullText: `${artist} - ${title}`,
            sales: Number(String(sales).replace(/,/g, "")) || 0,
          });
        }
      }
    });

    return {
      regionId,
      regionName,
      success: true,
      rows,
    };
  } catch (error) {
    return {
      regionId,
      regionName,
      success: false,
      rows: [],
      error: error.message,
    };
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;

  async function runner() {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= items.length) break;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runner()
  );

  await Promise.all(workers);
  return results;
}

async function fetchAllRegions(concurrency = 10) {
  const regionEntries = Object.entries(REGIONS).map(([id, name]) => ({
    id,
    name,
  }));

  return runWithConcurrency(regionEntries, concurrency, async ({ id, name }) => {
    return fetchRegion(id, name);
  });
}

function matchQuery(item, query, exact) {
  const itemArtist = normalize(item.artist);
  const itemTitle = normalize(item.title);
  const itemFull = normalize(item.fullText);

  const queryArtist = normalize(query.artist);
  const queryTitle = normalize(query.title);
  const queryFull = normalize(`${query.artist} - ${query.title}`);

  if (exact) {
    return (
      (itemArtist === queryArtist && itemTitle === queryTitle) ||
      itemFull === queryFull
    );
  }

  return (
    (itemArtist.includes(queryArtist) && itemTitle.includes(queryTitle)) ||
    (itemFull.includes(queryArtist) && itemFull.includes(queryTitle))
  );
}

function findArtistRanks(allRegionData, artistName, options = {}) {
  const { exact = false, firstOnly = true } = options;

  const keyword = normalize(artistName);
  const found = [];

  for (const region of allRegionData) {
    if (!region.success) continue;

    const matches = region.rows.filter((item) => {
      const artist = normalize(item.artist);
      return exact ? artist === keyword : artist.includes(keyword);
    });

    if (!matches.length) continue;

    if (firstOnly) {
      const best = matches[0];
      found.push({
        region: region.regionName,
        regionId: region.regionId,
        rank: best.rank,
        artist: best.artist,
        title: best.title,
        fullText: best.fullText,
        sales: best.sales,
      });
    } else {
      for (const match of matches) {
        found.push({
          region: region.regionName,
          regionId: region.regionId,
          rank: match.rank,
          artist: match.artist,
          title: match.title,
          fullText: match.fullText,
          sales: match.sales,
        });
      }
    }
  }

  return found.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.region.localeCompare(b.region);
  });
}

function findArtistRanksCustom(allRegionData, query, options = {}) {
  const {
    exact = false,
    firstOnly = true,
    extendedTopRegions = new Set(),
    defaultTopLimit = 1,
    extendedTopLimit = 100,
  } = options;

  const found = [];

  for (const region of allRegionData) {
    if (!region.success) continue;

    const limit = extendedTopRegions.has(region.regionName)
      ? extendedTopLimit
      : defaultTopLimit;

    const filteredRows = region.rows.filter((item) => item.rank <= limit);
    const matches = filteredRows.filter((item) => matchQuery(item, query, exact));

    if (!matches.length) continue;

    if (firstOnly) {
      const best = matches[0];
      found.push({
        region: region.regionName,
        regionId: region.regionId,
        rank: best.rank,
        artist: best.artist,
        title: best.title,
        fullText: best.fullText,
        sales: best.sales,
      });
    } else {
      for (const match of matches) {
        found.push({
          region: region.regionName,
          regionId: region.regionId,
          rank: match.rank,
          artist: match.artist,
          title: match.title,
          fullText: match.fullText,
          sales: match.sales,
        });
      }
    }
  }

  return found.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.region.localeCompare(b.region);
  });
}

module.exports = {
  fetchRegion,
  fetchAllRegions,
  findArtistRanks,
  findArtistRanksCustom,
};