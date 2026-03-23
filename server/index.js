const express = require("express");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const { MongoClient } = require("mongodb"); // 关键修改 1: 引入 MongoDB

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
  const cityName = (city || "Dublin").trim();
  if (IRISH_CITY_COORDS[cityName]) {
    return IRISH_CITY_COORDS[cityName];
  }
  return IRISH_CITY_COORDS.Dublin;
}

const app = express();
const PORT = process.env.PORT || 3000;

// 关键修改 2: MongoDB 初始化配置
const uri = process.env.MONGO_URI || "mongodb+srv://letitgrenn:ths20060913@qi.pf1cmkg.mongodb.net/?appName=qi";
const client = new MongoClient(uri);
let itemsCollection; // 全局集合变量

const openai = new OpenAI({
  apiKey: process.env.DEESEEK_API_KEY || "sk-008ec806b7ed408db3fe0f704bb3be24",
  baseURL: "https://api.deepseek.com",
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

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

// API: list items (关键修改 3: 从数据库获取)
app.get("/api/items", async (req, res) => {
  try {
    const dbItems = await itemsCollection.find({}).sort({ _id: -1 }).toArray();
    res.json(dbItems);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch items" });
  }
});

// API: get single item (关键修改 4: 从数据库查找)
app.get("/api/items/:id", async (req, res) => {
  try {
    const item = await itemsCollection.findOne({ id: req.params.id });
    if (!item) return res.status(404).json({ error: "Item not found" });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// API: create item (关键修改 5: 存入数据库)
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

  // AI 提取关键词逻辑保持不变
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
    // 1. 拿到 AI 的原始回复
    let content = response.choices[0].message.content;

    // 2. 增加这一段：清理掉 Markdown 的外壳
    let cleanedContent = content;
    if (cleanedContent.includes("```")) {
        // 这行正则会自动去掉 ```json 和结尾的 ```
        cleanedContent = cleanedContent.replace(/```json\n?|```\n?/g, "").trim();
    }

    // 3. 然后再解析
    try {
        keywords = JSON.parse(cleanedContent);
    } catch (e) {
        console.error("解析 JSON 失败，尝试二次修复...");
        // 最后的防线：尝试用正则提取第一个 { 和最后一个 } 之间的内容
        const match = cleanedContent.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (match) {
            keywords = JSON.parse(match[0]);
        } else {
            keywords = []; // 如果实在不行，给个空数组
        }
    }
  } catch (err) {
    console.error("Keyword extraction failed", err);
    keywords = description.split(' ').slice(0, 5);
  }

  // 1. AI 估算碳排放逻辑保持不变
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

  // 2. 地址解析逻辑保持不变
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

  newItem.co2Saved = computeCo2SavedForItem(newItem);

  // 关键：存入 MongoDB
  await itemsCollection.insertOne(newItem);
  res.status(201).json(newItem);
});

// Vision / AI 图像分析 (全部保留)
app.post("/api/vision/analyze", async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: "Image is required" });

  try {
    let imageBuffer;
    if (image.startsWith("data:")) {
      const base64Data = image.split(",")[1];
      imageBuffer = Buffer.from(base64Data, "base64");
    } else {
      imageBuffer = Buffer.from(image);
    }

    const result = await Tesseract.recognize(imageBuffer, "eng");
    const extractedText = (result.data.text || "").trim();

    let guessedCategory = null;
    try {
      const stats = await sharp(imageBuffer).stats();
      const [r, g, b] = stats.channels.map((c) => c.mean);
      if (g > r && g > b) guessedCategory = "plant";
      else if (b > r && b > g) guessedCategory = "electronics";
      else if (r > g && r > b) guessedCategory = "clothing";
      else guessedCategory = "item";
    } catch (err) {}

    const mention = guessedCategory ? `The image likely shows a ${guessedCategory}.` : "";
    const productDescription = extractedText || "No recognizable text was found in the photo.";

    const prompt = `You are helping create a product listing for a second-hand marketplace.\n\n${mention}\n\nHere is text extracted from the photo: \"${productDescription}\"\n\nGenerate a product title (3-5 words) and a 2-3 sentence description that could be used in a listing. Return ONLY valid JSON (no markdown, no code blocks):\n{\n  \"title\": \"...\",\n  \"description\": \"...\"\n}`;

    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
    });

    const content = String(response.choices[0]?.message?.content || "").trim();
    let parsed;
    try {
      let cleaned = content;
      if (cleaned.includes("```json")) {
        cleaned = cleaned.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      }
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const match = content.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { title: "Second-hand Item", description: content };
    }

    res.json({
      status: "ok",
      suggestion: {
        title: parsed.title || "Second-hand Item",
        description: parsed.description || "A great item for Dublin students"
      },
      extractedText: extractedText.substring(0, 200)
    });
  } catch (err) {
    res.status(500).json({ error: "AI analysis failed" });
  }
});

// AI 增强接口 (全部保留)
app.post("/api/ai/enhance", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Text is required" });
  try {
    const prompt = `Enhance this product description for a second-hand marketplace. Return JSON: {"enhancedText": "...", "keywords": ["key1", "key2"]}`;
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
    });
    const raw = String(response.choices[0]?.message?.content || "");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { enhancedText: raw.trim(), keywords: [] };
    }
    res.json({ status: "ok", enhancedText: parsed.enhancedText || text, keywords: parsed.keywords || [] });
  } catch (err) {
    res.status(500).json({ error: "AI enhancement failed" });
  }
});

// AI 搜索 (关键修改 6: 先从 DB 读，再过滤)
app.post("/api/search", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Query is required" });
  try {
    const prompt = `User search query: "${query}". Return JSON: {"matches": [{"itemId": "id", "compatibilityScore": 85, "valueIndex": 90, "reason": "..."}]}`;
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const matches = parsed.matches || [];
    
    // 从数据库拿所有物品
    const allItems = await itemsCollection.find({}).toArray();
    const matchedItems = allItems.filter(item => matches.some(m => m.itemId === item.id));
    
    const enrichedItems = matchedItems.map(item => {
      const match = matches.find(m => m.itemId === item.id);
      return { ...item, compatibilityScore: match?.compatibilityScore || 0, valueIndex: match?.valueIndex || 0, matchReason: match?.reason || "" };
    });
    res.json({ items: enrichedItems });
  } catch (err) {
    const term = query.toLowerCase();
    const allItems = await itemsCollection.find({}).toArray();
    const filtered = allItems.filter(item =>
      item.title.toLowerCase().includes(term) ||
      item.description.toLowerCase().includes(term)
    );
    res.json({ items: filtered });
  }
});

// 静态服务
const clientDistPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDistPath));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(clientDistPath, "index.html"), (err) => {
    if (err) next();
  });
});

// 关键修改 7: 异步启动，确保 DB 连上
async function startServer() {
  try {
    await client.connect();
    console.log("✅ MongoDB Atlas Connected!");
    const db = client.db("letitgreen");
    itemsCollection = db.collection("items");

    // 数据初始化：如果库为空，存入第一个商品
    const count = await itemsCollection.countDocuments();
    if (count === 0) {
      const seed = {
        id: "1",
        title: "Plant Jasmeen",
        description: "Healthy indoor plant in a ceramic pot. Looking for a new home in Dublin.",
        price: 10,
        currency: "EUR",
        location: { label: "Grafton Street, Dublin", city: "Dublin", lat: 53.3425, lng: -6.2605 },
        co2Saved: 12.5,
        imageUrl: "https://imagesvc.meredithcorp.io/v3/mm/image?q=60&c=sc&poi=[1060%2C788]&w=2000&h=1000&url=https:%2F%2Fstatic.onecms.io%2Fwp-content%2Fuploads%2Fsites%2F34%2F2020%2F11%2F23%2Fjasmine-plant-windowsill-getty-1220-2000.jpg",
        tags: ["living", "plant"]
      };
      await itemsCollection.insertOne(seed);
    }

    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ DB connection failed:", err);
  }
}

startServer();