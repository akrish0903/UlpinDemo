/** -------------- YOUR ORIGINAL IMPORTS -------------- **/
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const util = require("util");
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);

/** -------------- NEW IMPORTS (FOR SHP UPLOAD) -------------- **/
async function parseShapefile(filePath) {
  const shp = (await import("shpjs")).default;
  const geojson = await shp(filePath);
  return geojson;
}
const JSZip = require("jszip");
const fsPromises = require("fs").promises;
const turf = require("@turf/turf");

/** -------------- INIT SERVER -------------- **/
const app = express();
const PORT = process.env.PORT || 3000;

/** -------------- DIRECTORIES -------------- **/
const uploadDir = path.join(__dirname, "upload");
const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "ownerEntries.json");
const buildingsFile = path.join(dataDir, "createBuilding.geojson");
const createBuildingGeoFile = path.join(dataDir, "createBuilding.geojson");

/** -------------- CREATE DIRECTORIES IF NOT EXISTS -------------- **/
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dataFile))
  fs.writeFileSync(dataFile, JSON.stringify({}, null, 2));
if (!fs.existsSync(buildingsFile))
  fs.writeFileSync(
    buildingsFile,
    JSON.stringify({ type: "FeatureCollection", features: [] }, null, 2)
  );

/** -------------- MIDDLEWARES -------------- **/
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use("/upload", express.static(uploadDir));
app.use(express.static(__dirname));

/** -------------- IMAGE UPLOAD STORAGE -------------- **/
const storage = multer.diskStorage({
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
  destination: (req, file, cb) => cb(null, uploadDir),
});
const upload = multer({ storage });

/** -------------- YOUR EXISTING HELPER FUNCTIONS -------------- **/
function loadEntries() {
  try {
    const raw = fs.readFileSync(dataFile, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    return {};
  }
}
function saveEntries(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}
function loadBuildings() {
  try {
    const raw = fs.readFileSync(buildingsFile, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (
      parsed &&
      parsed.type === "FeatureCollection" &&
      Array.isArray(parsed.features)
    )
      return parsed;
    return { type: "FeatureCollection", features: [] };
  } catch (e) {
    return { type: "FeatureCollection", features: [] };
  }
}
function saveBuildings(fc) {
  const safe =
    fc && fc.type === "FeatureCollection" && Array.isArray(fc.features)
      ? fc
      : { type: "FeatureCollection", features: [] };
  fs.writeFileSync(buildingsFile, JSON.stringify(safe, null, 2));
}

function loadCreateBuildingFeatures() {
  try {
    const raw = fs.readFileSync(createBuildingGeoFile, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (parsed?.type === "FeatureCollection" && Array.isArray(parsed.features))
      return parsed.features;
  } catch (err) {
    console.warn("Failed to read createBuilding.geojson:", err.message);
  }
  return [];
}

function getCreateBuildingFeature(bid) {
  const list = loadCreateBuildingFeatures();
  return list.find(
    (feature) => feature?.properties && Number(feature.properties.BID) === bid
  );
}

function boundsFromBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if ([minLon, minLat, maxLon, maxLat].some((v) => !isFinite(v))) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function normPropLookup(props = {}, key) {
  const lowered = key.toLowerCase();
  for (const [k, value] of Object.entries(props)) {
    if (k && k.toLowerCase() === lowered) return value;
  }
  return undefined;
}

function roomsFromFloorLayouts(bid) {
  const layouts = loadFloorLayouts();
  const prefix = `${bid}_floor_`;
  const entries = Object.entries(layouts || {})
    .filter(([key]) => key.startsWith(prefix))
    .sort((a, b) => {
      const toNum = (key) => Number(key.split("_floor_")[1]) || 0;
      return toNum(a[0]) - toNum(b[0]);
    });

  const rooms = [];
  for (const [key, value] of entries) {
    const floorNumber = key.split("_floor_")[1] || "1";
    const apartments = value?.apartments || {};
    for (const [aptKey, aptData] of Object.entries(apartments)) {
      const grid = aptData?.grid || { cols: 10, rows: 10 };
      const cols = grid.cols || 1;
      const rows = grid.rows || 1;
      const aptRooms = Array.isArray(aptData?.rooms) ? aptData.rooms : [];
      aptRooms.forEach((room, idx) => {
        const bounds = {
          x: (room?.x || 0) / cols,
          y: (room?.y || 0) / rows,
          width: (room?.width || 0) / cols,
          height: (room?.height || 0) / rows,
        };
        rooms.push({
          id:
            room?.id ||
            `floor-${floorNumber}-apt-${aptKey}-room-${idx}-${Date.now()}`,
          type: room?.type || "room",
          name:
            room?.name || `Floor ${floorNumber} Apt ${aptKey} Room ${idx + 1}`,
          bounds,
          polygon: null,
          pniu: room?.pniu || {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
          },
        });
      });
    }
    if (rooms.length) break;
  }
  return rooms;
}

/** -------------- IMAGE UPLOAD ROUTES -------------- **/
app.post("/api/upload-image", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  return res.json({ url: `/upload/${req.file.filename}` });
});

app.post("/api/upload-data-url", (req, res) => {
  try {
    const { dataUrl, filename } = req.body || {};
    if (!dataUrl || typeof dataUrl !== "string") {
      return res.status(400).json({ error: "dataUrl required" });
    }
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: "Invalid dataUrl" });

    const mime = match[1];
    const base64 = match[2];
    const ext = mime.split("/")[1] || "png";
    const safeName = (filename || `image-${Date.now()}.${ext}`).replace(
      /[^a-zA-Z0-9_.-]/g,
      "_"
    );

    const finalName = `${Date.now()}-${safeName}`;
    const filePath = path.join(uploadDir, finalName);

    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    return res.json({ url: `/upload/${finalName}` });
  } catch (e) {
    return res.status(500).json({ error: "Failed to save image" });
  }
});

/** -------------- OWNER ENTRY ROUTES -------------- **/
app.post("/api/save-entry", (req, res) => {
  try {
    const body = req.body || {};
    const key =
      body.key ||
      (body.propertyId && body.floorNo
        ? `${body.propertyId}__F${body.floorNo}`
        : null);

    const entry = body.entry;
    if (!key || !entry)
      return res.status(400).json({ error: "key and entry required" });

    const data = loadEntries();
    if (!Array.isArray(data[key])) data[key] = [];
    data[key].push(entry);

    if (data[key].length > 20) data[key] = data[key].slice(-20);
    saveEntries(data);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Failed to save entry" });
  }
});

app.get("/api/entries", (req, res) => {
  try {
    const { key, propertyId, floor } = req.query;
    const k = key || (propertyId && floor ? `${propertyId}__F${floor}` : null);
    if (!k)
      return res
        .status(400)
        .json({ error: "key or (propertyId & floor) required" });

    const data = loadEntries();
    return res.json({ key: k, entries: data[k] || [] });
  } catch (e) {
    return res.status(500).json({ error: "Failed to read entries" });
  }
});

/** -------------- BUILDINGS GEOJSON ROUTES -------------- **/
app.get("/api/buildings", (req, res) => {
  try {
    return res.json(loadBuildings());
  } catch (e) {
    return res.status(500).json({ error: "Failed to read buildings" });
  }
});

app.post("/api/buildings", (req, res) => {
  try {
    const feature = req.body && req.body.feature;
    if (!feature || !feature.geometry)
      return res.status(400).json({ error: "feature with geometry required" });

    const fc = loadBuildings();
    const bid = feature.properties && feature.properties.BID;
    if (bid == null)
      return res.status(400).json({ error: "feature.properties.BID required" });

    const exists = fc.features.find(
      (f) => (f.properties && f.properties.BID) == bid
    );
    if (exists)
      return res
        .status(409)
        .json({ error: "Building with this BID already exists" });

    fc.features.push(feature);
    saveBuildings(fc);
    return res.json({ ok: true, feature });
  } catch (e) {
    return res.status(500).json({ error: "Failed to save building" });
  }
});

/** -------------- FLOOR LAYOUT ROUTES (EXISTING) -------------- **/
const floorLayoutsFile = path.join(dataDir, "floorLayouts.json");

function loadFloorLayouts() {
  try {
    const raw = fs.readFileSync(floorLayoutsFile, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    return {};
  }
}
function saveFloorLayouts(data) {
  fs.writeFileSync(floorLayoutsFile, JSON.stringify(data, null, 2));
}

app.get("/api/floor-layouts", (req, res) => {
  try {
    return res.json(loadFloorLayouts());
  } catch (e) {
    return res.status(500).json({ error: "Failed to read floor layouts" });
  }
});

app.post("/api/floor-layouts", (req, res) => {
  try {
    const { buildingId, floorNumber, layout, apartment } = req.body;
    if (!buildingId || !floorNumber || !layout) {
      return res
        .status(400)
        .json({ error: "buildingId, floorNumber, and layout required" });
    }

    const layouts = loadFloorLayouts();
    const key = `${buildingId}_floor_${floorNumber}`;
    const aptKey = String(apartment || "1");

    if (!layouts[key] || typeof layouts[key] !== "object") {
      layouts[key] = { apartments: {} };
    }
    if (!layouts[key].apartments) {
      layouts[key].apartments = {};
    }

    layouts[key].apartments[aptKey] = layout;
    saveFloorLayouts(layouts);

    return res.json({ ok: true, key });
  } catch (e) {
    return res.status(500).json({ error: "Failed to save floor layout" });
  }
});

app.get("/api/floor-layouts/:buildingId/:floorNumber", (req, res) => {
  try {
    const { buildingId, floorNumber } = req.params;
    const aptParam = req.query && req.query.apartment;

    const layouts = loadFloorLayouts();
    const key = `${buildingId}_floor_${floorNumber}`;
    const node = layouts[key] || null;

    if (!node) return res.json({ layout: null });

    if (node.apartments) {
      const aptKey = String(aptParam || "1");
      return res.json({ layout: node.apartments[aptKey] || null });
    }

    return res.json({ layout: node || null });
  } catch (e) {
    return res.status(500).json({ error: "Failed to read floor layout" });
  }
});

/** -------------- SAVE COMMON FLOOR LAYOUT ROUTE -------------- **/
const ensureDataDirectory = async () => {
  const dataDir = path.join(__dirname, "data");
  try {
    await mkdir(dataDir, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      console.error("Error creating data directory:", error);
      throw error;
    }
  }
};

app.post("/api/save-layout", express.json(), async (req, res) => {
  try {
    await ensureDataDirectory();

    if (!req.body || !req.body.features || !Array.isArray(req.body.features)) {
      return res.status(400).json({ error: "Invalid request body" });
    }

    await writeFile(
      path.join(__dirname, "data", "BuildingCommonFloorLayout.json"),
      JSON.stringify(req.body, null, 2),
      "utf8"
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error saving layout:", error);
    res.status(500).json({
      error: "Failed to save layout",
      details: error.message,
    });
  }
});

/** ------------------------------------------------------------------
    ✅ NEW — SHAPEFILE UPLOAD → CONVERT TO COMMON LAYOUT
------------------------------------------------------------------- **/
const memUpload = multer({ storage: multer.memoryStorage() });

async function parseLocalZip(zipPath) {
  const { default: shp } = await import("shpjs");
  const zipData = await fsPromises.readFile(zipPath);
  const arrayBuffer = zipData.buffer.slice(
    zipData.byteOffset,
    zipData.byteOffset + zipData.byteLength
  );
  const geojson = await shp(arrayBuffer);
  return geojson;
}

app.post("/upload-shapefile", async (req, res) => {
  try {
    const geojson = await parseShapefile("uploads/myfile.zip");
    res.json(geojson);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to parse shapefile" });
  }
});

app.post(
  "/api/upload-common-layout",
  upload.single("file"),
  async (req, res) => {
    try {
      const BID = Number(req.body.BID);
      console.log("Uploaded:", req.file.originalname);
      console.log("Stored As:", req.file.path);

      const geojson = await parseLocalZip(req.file.path).catch((err) => {
        console.error("Parse Error:", err);
        throw new Error("Invalid .zip — must include .shp, .dbf, .shx");
      });
      if (!geojson || !geojson.features?.length)
        return res.status(400).json({ error: "Invalid SHP" });

      console.log("Parsed SHP:", geojson.features.length, "features");

      const featuresWithArea = geojson.features.map((feature) => ({
        feature,
        area: (() => {
          try {
            return turf.area(feature);
          } catch (e) {
            return 0;
          }
        })(),
      }));

      const buildingPoly =
        featuresWithArea.find((item) => {
          const props = item.feature?.properties || {};
          const typeVal = normPropLookup(props, "type");
          const featureType = typeVal
            ? String(typeVal).toLowerCase()
            : String(normPropLookup(props, "featureType") || "").toLowerCase();
          return featureType === "building";
        })?.feature ||
        featuresWithArea.reduce(
          (prev, curr) => (curr.area > (prev?.area || 0) ? curr : prev),
          null
        )?.feature;

      const roomPolys = geojson.features.filter((f) => {
        if (buildingPoly && f === buildingPoly) return false;
        const props = f?.properties || {};
        const typeVal = normPropLookup(props, "type");
        const featureType = typeVal
          ? String(typeVal).toLowerCase()
          : String(normPropLookup(props, "featureType") || "").toLowerCase();
        if (featureType === "room") return true;
        if (featureType && featureType !== "building") return true;
        return Boolean(buildingPoly) ? f !== buildingPoly : true;
      });

      if (!buildingPoly)
        return res.status(400).json({ error: "Building polygon missing" });

      const bbox = turf.bbox(buildingPoly);
      const [minLon, minLat, maxLon, maxLat] = bbox;

      const rooms = roomPolys.map((f, idx) => {
        const coordinates = turf.getCoords(f);
        const poly = Array.isArray(coordinates[0])
          ? coordinates[0]
          : coordinates;
        const props = f?.properties || {};
        const sourceId =
          normPropLookup(props, "id") || normPropLookup(props, "room_id");
        const sourceName =
          normPropLookup(props, "name") || normPropLookup(props, "room_name");
        const sourceType =
          normPropLookup(props, "room_type") ||
          normPropLookup(props, "type") ||
          normPropLookup(props, "category");

        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;

        poly.forEach(([lon, lat]) => {
          const x = (lon - minLon) / (maxLon - minLon);
          const y = (lat - minLat) / (maxLat - minLat);

          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        });

        return {
          id: sourceId || `room-${Date.now()}-${idx}`,
          type:
            sourceType && sourceType !== "building"
              ? String(sourceType)
              : "room",
          name: sourceName || `Room ${idx + 1}`,
          bounds: {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
          },
          polygon: null,
          pniu: {
            x: minX + (maxX - minX) / 2,
            y: minY + (maxY - minY) / 2,
          },
        };
      });

      const fallbackRooms =
        rooms.length === 0 ? roomsFromFloorLayouts(BID) : [];
      const mergedRooms = rooms.length ? rooms : fallbackRooms;

      const filePath = "data/BuildingCommonFloorLayout.json";
      let json = { type: "FeatureCollection", features: [] };

      if (fs.existsSync(filePath))
        json = JSON.parse(fs.readFileSync(filePath, "utf8"));

      const idx = json.features.findIndex((f) => f.properties.BID === BID);

      const createBuildingFeature = getCreateBuildingFeature(BID);
      const buildingDetails = createBuildingFeature?.properties
        ? {
            name:
              createBuildingFeature.properties.NAME ||
              createBuildingFeature.properties.name ||
              null,
            height: createBuildingFeature.properties.height ?? null,
            floors: createBuildingFeature.properties.floors ?? null,
            apartmentCounts:
              createBuildingFeature.properties.apartmentCounts || null,
          }
        : null;

      let boundsOverride = boundsFromBbox(
        createBuildingFeature ? turf.bbox(createBuildingFeature) : null
      ) || { minLon, minLat, maxLon, maxLat };

      const layout = {
        bounds: boundsOverride,
        rooms: mergedRooms,
      };

      const updatedFeature = {
        type: "Feature",
        properties: {
          BID,
          bounds: boundsOverride,
          rooms: layout.rooms,
          buildingDetails,
        },
        geometry:
          createBuildingFeature?.geometry || buildingPoly.geometry || null,
      };

      if (idx >= 0) json.features[idx] = updatedFeature;
      else json.features.push(updatedFeature);

      fs.writeFileSync(filePath, JSON.stringify(json, null, 2));

      res.json({ success: true, layout });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to import layout" });
    }
  }
);

/** ---------------------- ERROR HANDLER ---------------------- **/
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({
    error: "Internal server error",
    details: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

/** ---------------------- START SERVER ---------------------- **/
app.listen(PORT, () => {
  console.log(
    `Server running at https://ulpindemo.onrender.com, 
                  https://ulpindemo.onrender.com/createBuilding.html, - Main CURRENT FILE
                                                             - User Can Create & Edit Building,
                                                             - Insert/Update Owner Details Floor Wise,
                                                             - Create Floor Layout
                  https://ulpindemo.onrender.com/BuildingOwnerEntry.html, - User Can Insert owner details
                  https://ulpindemo.onrender.com/BuildingsInTilangpurKotlaVillage.html, - Multiple Buildings No functions
                  https://ulpindemo.onrender.com/BuildingWIthHeight.html, - single building with hight & floor change
                  https://ulpindemo.onrender.com/heightBuildingEnhanced.html, - Multiple Buildings along a road
                  https://ulpindemo.onrender.com/DrawBuildingFloorLayout.html`
  );
});
