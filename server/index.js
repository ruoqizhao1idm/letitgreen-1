const express = require("express");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");

dotenv.config();

// 爱尔兰主要城市中心坐标（地理编码失败时的回退）
const IRISH_CITY_COORDS = {
  Dublin: { lat: 53.3498, lng: -6.2603 },
  Cork: { lat: 51.8985, lng: -8.4756 },
  Galway: { lat: 53.2707, lng: -9.0568 },
  Limerick: { lat: 52.6639, lng: -8.6267 },
  Waterford: { lat: 52.2593, lng: -7.1101 },
  Belfast: { lat: 54.5973, lng: -5.9301 },
  Derry: { lat: 54.9966, lng: -7.3086 },
  Drogheda: { lat: 53.7179, lng: -6.3581 },
  Dundalk: { lat: 54.0060, lng: -6.4027 },
  Bray: { lat: 53.2027, lng: -6.0983 },
  Sligo: { lat: 54.2766, lng: -8.4761 },
  Kilkenny: { lat: 52.6541, lng: -7.2448 }
};

async function geocodeAddress(location) {
  const { city, address, postcode } = location || {};
  const parts = [address, city, postcode, "Ireland"].filter(Boolean);
  if (parts.length < 1) return null;
  const query = parts.length >= 2 ? parts.join(", ") : `${parts[0]}, Ireland`;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      { headers: { "User-Agent": "GreenMarket/1.0" } }
    );
    const data = await res.json();
    if (Array.isArray(data) && data[0]) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (err) {
    console.error("Geocoding failed:", err);
  }
  // 回退：使用城市中心坐标
  const cityName = (city || "Dublin").trim();
  if (IRISH_CITY_COORDS[cityName]) {
    return IRISH_CITY_COORDS[cityName];
  }
  return IRISH_CITY_COORDS.Dublin;
}

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.DEESEEK_API_KEY || "sk-008ec806b7ed408db3fe0f704bb3be24",
  baseURL: "https://api.deepseek.com",
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// In-memory data store (seed data so cards show on first load)
let items = [
  {
    id: "1",
    title: "Plant Jasmeen",
    description:
      "Healthy indoor plant in a ceramic pot. Looking for a new home in Dublin.",
    price: 10,
    currency: "EUR",
    distanceKm: 0.5,
    location: {
      label: "Grafton Street, Dublin",
      city: "Dublin",
      address: "Grafton Street",
      postcode: "D02",
      lat: 53.3425,
      lng: -6.2605
    },
    condition: "New",
    brand: "Local",
    co2Kg: -2.3,
    postedMinutesAgo: 30,
    imageUrl:
      "https://imagesvc.meredithcorp.io/v3/mm/image?q=60&c=sc&poi=[1060%2C788]&w=2000&h=1000&url=https:%2F%2Fstatic.onecms.io%2Fwp-content%2Fuploads%2Fsites%2F34%2F2020%2F11%2F23%2Fjasmine-plant-windowsill-getty-1220-2000.jpg",
    tags: ["living", "plant"]
  }
];

// Helper: compute CO2 saved for an item (kg)
const computeCo2SavedForItem = (it) => {
  const p = typeof it.productionEmission === "number" ? it.productionEmission : null;
  const d = typeof it.decayRate === "number" ? it.decayRate : null;

  if (p !== null && d !== null) {
    return Math.max(0, p * (1 - d));
  }
  if (p !== null) {
    return Math.max(0, p * (1 - 0.2));
  }
  if (typeof it.co2Kg === "number") {
    return Math.abs(it.co2Kg);
  }

  // Heuristic fallback based on tags and price
  let base = 20;
  if (it.tags?.includes("electronics")) base = 80;
  else if (it.tags?.includes("living") || it.tags?.includes("plant")) base = 15;
  else if (it.tags?.includes("clothing")) base = 8;
  else if (it.tags?.includes("sports")) base = 25;

  const priceFactor = Math.min(3, Math.max(0.5, (Number(it.price) || 20) / 50));
  const estimatedProduction = base * priceFactor;
  const assumedDecay = 0.2;
  return Math.max(0, estimatedProduction * (1 - assumedDecay));
};

// Ensure seed items have co2Saved computed
items = items.map((it) => ({ ...it, co2Saved: computeCo2SavedForItem(it) }));

// API: list items
app.get("/api/items", (req, res) => {
  res.json(items);
});

// API: get single item
app.get("/api/items/:id", (req, res) => {
  const item = items.find((i) => i.id === req.params.id);
  if (!item) {
    return res.status(404).json({ error: "Item not found" });
  }
  res.json(item);
});

// API: create item
app.post("/api/items", async (req, res) => {
  const {
    title,
    description,
    price,
    currency = "EUR",
    location,
    condition,
    brand,
    co2Kg,
    imageUrl,
    tags
  } = req.body || {};

  const numPrice = typeof price === "string" ? parseFloat(price) : price;
  if (!title || !description || (numPrice !== 0 && !numPrice)) {
    return res.status(400).json({
      error: "title, description and price are required",
      received: { title: !!title, description: !!description, price }
    });
  }

  // Extract keywords using AI
  let keywords = [];
  try {
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "user",
          content: `Extract key search keywords from this product description: "${description}". Return as JSON array of strings.`
        }
      ],
    });
    const content = response.choices[0].message.content;
    keywords = JSON.parse(content) || [];
  } catch (err) {
    console.error("Keyword extraction failed", err);
    // Fallback to simple split
    keywords = description.split(' ').slice(0, 5);
  }

  // 1. AI 估算该商品减少的碳排放量（kg CO2）
  let aiCo2Kg = null;
  try {
    const aiRes = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "user",
          content: `Estimate how much CO2 (in kg) is saved by buying this second-hand item instead of new. Consider: item type="${title}", description="${description}", price=${numPrice} EUR. Return ONLY a single number (e.g. 2.3 or 15), no units or explanation.`
        }
      ]
    });
    const parsed = parseFloat(String(aiRes.choices[0]?.message?.content || "").replace(/,/g, ".").trim());
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 500) aiCo2Kg = parsed;
  } catch (err) {
    console.error("AI CO2 estimation failed", err);
  }

  // 2. 根据用户填写的地址解析经纬度
  let lat = location?.lat;
  let lng = location?.lng;
  const coords = await geocodeAddress(location);
  if (coords) {
    lat = coords.lat;
    lng = coords.lng;
  }
  if (lat == null) lat = 53.3438;
  if (lng == null) lng = -6.2546;

  const newItem = {
    id: String(Date.now()),
    title: String(title).trim(),
    description: String(description).trim(),
    price: Number(numPrice),
    currency: currency || "EUR",
    distanceKm: location?.distanceKm ?? 0.5,
    location: {
      label: location?.label || location?.city || "Dublin",
      city: location?.city || "Dublin",
      address: location?.address || "",
      postcode: location?.postcode || "",
      lat,
      lng
    },
    condition: condition || "Used",
    brand: brand ? String(brand).trim() : "-",
    co2Kg: typeof co2Kg === "number" ? co2Kg : (aiCo2Kg != null ? -aiCo2Kg : -2.3),
    postedMinutesAgo: 0,
    imageUrl:
      imageUrl && typeof imageUrl === "string" && imageUrl.startsWith("data:")
        ? imageUrl
        : imageUrl ||
          "https://images.pexels.com/photos/5699666/pexels-photo-5699666.jpeg?auto=compress&cs=tinysrgb&w=800",
    tags: Array.isArray(tags) ? tags : [],
    keywords: keywords
  };

  // Compute and attach co2Saved for the new item
  newItem.co2Saved = computeCo2SavedForItem(newItem);

  items.unshift(newItem);
  res.status(201).json(newItem);
});

// Vision / AI image analysis endpoint
app.post("/api/vision/analyze", async (req, res) => {
  const { image } = req.body;
  console.log("Vision analyze request received", { imageSize: image?.length });
  if (!image) {
    return res.status(400).json({ error: "Image is required" });
  }

  try {
    // Step 1: Extract image data and convert to buffer
    let imageBuffer;
    const imageDataUrl = image.startsWith("data:") ? image : null;
    if (image.startsWith("data:")) {
      const base64Data = image.split(",")[1];
      imageBuffer = Buffer.from(base64Data, "base64");
    } else {
      imageBuffer = Buffer.from(image);
    }

    console.log("Processing image with local OCR (Tesseract)...");
    const result = await Tesseract.recognize(imageBuffer, "eng");
    const extractedText = (result.data.text || "").trim();
    console.log("Extracted text from image:", extractedText.substring(0, 200));

    // Simple heuristic: if the image is predominantly green, guess it's a plant; if blue, guess electronics.
    let guessedCategory = null;
    try {
      const stats = await sharp(imageBuffer).stats();
      const [r, g, b] = stats.channels.map((c) => c.mean);
      if (g > r && g > b) guessedCategory = "plant";
      else if (b > r && b > g) guessedCategory = "electronics";
      else if (r > g && r > b) guessedCategory = "clothing";
      else guessedCategory = "item";
    } catch (err) {
      // ignore, heuristic is optional
    }

    // Step 2: Ask the AI to suggest a title/description based on extracted text and color heuristic
    const mention = guessedCategory ? `The image likely shows a ${guessedCategory}.` : "";
    const productDescription = extractedText || "No recognizable text was found in the photo.";

    const prompt = `You are helping create a product listing for a second-hand marketplace.\n\n${mention}\n\nHere is text extracted from the photo: \"${productDescription}\"\n\nGenerate a product title (3-5 words) and a 2-3 sentence description that could be used in a listing. Return ONLY valid JSON (no markdown, no code blocks):\n{\n  \"title\": \"...\",\n  \"description\": \"...\"\n}`;

    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        { role: "user", content: prompt }
      ],
    });

    const content = String(response.choices[0]?.message?.content || "").trim();
    console.log("AI response:", content.substring(0, 200));

    let parsed;
    try {
      let cleaned = content;
      if (cleaned.includes("```json")) {
        cleaned = cleaned.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      }
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.log("Failed to parse JSON response, using fallback", e.message);
      // Try to recover JSON-like substring
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch (err) {
          parsed = null;
        }
      }
      if (!parsed) {
        parsed = {
          title: "Second-hand Item",
          description: content || "A great item for Dublin students"
        };
      }
    }

    res.json({
      status: "ok",
      suggestion: {
        title: parsed.title || "Second-hand Item",
        description: parsed.description || "A great item for Dublin students"
      },
      extractedText: extractedText.substring(0, 200) // Debug info
    });
  } catch (err) {
    console.error("Vision analyze failed:", err);
    res.status(500).json({
      error: "AI analysis failed: " + (err.message || "Unknown error")
    });
  }
});

app.post("/api/ai/enhance", async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "Text is required" });
  }
  try {
    const prompt = `Enhance this product description for a second-hand marketplace. If the input is very short (1-5 words), expand it into a full listing description that includes likely category, condition, and why someone would want it.\n\nInput: "${text}"\n\nReturn JSON (no markdown/code fences): {"enhancedText": "...", "keywords": ["key1", "key2"]}`;

    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
    });

    const raw = String(response.choices[0]?.message?.content || "");
    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Try to recover JSON-like substring
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch (err) {
          parsed = null;
        }
      }
      if (!parsed) {
        parsed = {
          enhancedText: raw.trim(),
          keywords: []
        };
      }
    }

    res.json({
      status: "ok",
      enhancedText: parsed.enhancedText || text,
      keywords: parsed.keywords || []
    });
  } catch (err) {
    console.error("AI enhance failed", err);
    res.status(500).json({ error: "AI enhancement failed" });
  }
});

// API: AI search
app.post("/api/search", async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: "Query is required" });
  }
  try {
    // Use AI to analyze query and find matching items
    const prompt = `User search query: "${query}". Analyze this query for a second-hand marketplace. Consider context like Dublin student dorms (typical size ~10-15 sqm). For items that match, calculate a "compatibility score" (0-100) based on size fit for small spaces, and a "value index" (0-100) based on price vs quality. Return JSON: {"matches": [{"itemId": "id", "compatibilityScore": 85, "valueIndex": 90, "reason": "brief explanation"}]}`;
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
    });
    const content = response.choices[0].message.content;
    const parsed = JSON.parse(content);
    const matches = parsed.matches || [];
    // Filter items based on matches
    const matchedItems = items.filter(item => matches.some(m => m.itemId === item.id));
    // Add scores to items
    const enrichedItems = matchedItems.map(item => {
      const match = matches.find(m => m.itemId === item.id);
      return { ...item, compatibilityScore: match?.compatibilityScore || 0, valueIndex: match?.valueIndex || 0, matchReason: match?.reason || "" };
    });
    res.json({ items: enrichedItems });
  } catch (err) {
    console.error("AI search failed", err);
    // Fallback to simple search
    const term = query.toLowerCase();
    const filtered = items.filter(item =>
      item.title.toLowerCase().includes(term) ||
      item.description.toLowerCase().includes(term) ||
      item.keywords?.some(k => k.toLowerCase().includes(term))
    );
    res.json({ items: filtered });
  }
});

// Optional: serve built client
const clientDistPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDistPath));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(clientDistPath, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
