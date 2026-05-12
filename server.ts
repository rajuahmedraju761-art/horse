import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import OpenAI from "openai";
import { initializeApp } from "firebase/app";
import { 
  getFirestore, 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  limit, 
  getDocs,
  Timestamp,
  serverTimestamp
} from "firebase/firestore";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "firebase-applet-config.json"), "utf8"));
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  // API Routes
  app.post("/api/upload", async (req, res) => {
    try {
      const { image, screenType, raceId: rawRaceId, race_id, raceID } = req.body;
      const raceId = (rawRaceId || race_id || raceID || "UNKNOWN")?.trim().toUpperCase();

      console.log(`[API] Upload attempt. Race: ${raceId}, Type: ${screenType}`);

      // Strict validation of the incoming JSON payload
      if (!image) {
        return res.status(400).json({ error: "Missing required field: 'image'. Expected base64 string or Data URL." });
      }
      if (!screenType || !["ExactaMatrix", "WPSPools"].includes(screenType)) {
        return res.status(400).json({ error: "Invalid or missing 'screenType'. Must be 'ExactaMatrix' or 'WPSPools'." });
      }
      if (!raceId) {
        return res.status(400).json({ error: "Missing required field: 'raceId'." });
      }

      // Check for API Key
      if (!process.env.OPENAI_API_KEY) {
        console.error("[API] OPENAI_API_KEY is missing!");
        return res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server." });
      }

      // Strip data URL prefix if present (e.g., "data:image/png;base64,")
      const base64Data = image.includes("base64,") ? image.split("base64,")[1] : image;

      // 1. Parse Image with Gemini
      const precisionPrompt = screenType === "ExactaMatrix" 
        ? `You are a high-precision optical character recognition expert specialized in reading financial and betting matrices. 
Your specific task is to extract exact numerical values from the provided image of a horse racing Exacta Matrix.

Rules:
1. Parse the image meticulously, row by row and column by column.
2. The exact grid size is 10x10. 
3. Pay extreme attention to small digits and decimal points. Do not approximate or guess.
4. If a cell is empty or illegible, return null for that cell, do not invent a number.
5. Return ONLY a pure JSON object with a 'matrix' property. The 'matrix' MUST be an array of 10 objects, where each object represents a row (keys are "1" through "10").`
        : `You are a high-precision optical character recognition expert. 
Your task is to extract exact numerical values from the provided image of a horse racing WPS (Win, Place, Show) Pools screen.

Rules:
1. Parse the image meticulously for each horse number.
2. Extract the pool amounts for Win, Place, and Show.
3. Pay extreme attention to digits and decimal points.
4. If a value is missing, use null.
5. Return ONLY a pure JSON object in this format: { "horses": [{ "number": 1, "win": 100.0, "place": 50.0, "show": 25.0 }, ...] }`;

      console.log(`[OpenAI] Sending image for analysis...`);
      let responseText = "";
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: precisionPrompt },
                { type: "image_url", image_url: { url: image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}` } }
              ]
            }
          ]
        });
        responseText = response.choices[0].message.content || "{}";
        console.log(`[OpenAI] Analysis complete for ${raceId}`);
      } catch (openaiError: any) {
        console.error(`[OpenAI] Error: ${openaiError.message}`);
        return res.status(502).json({ error: `OpenAI processing failed: ${openaiError.message}` });
      }

      let parsedData;
      try {
        parsedData = JSON.parse(responseText);
      } catch (parseError: any) {
        console.error(`[OpenAI] Invalid JSON returned`);
        return res.status(502).json({ 
          error: "AI returned invalid JSON format", 
          rawResponse: responseText 
        });
      }

      // 2. Retrieve previous entry from Firestore
      let previousEntry = null;
      try {
        const q = query(
          collection(db, "odds_history"),
          where("raceId", "==", raceId),
          where("screenType", "==", screenType),
          orderBy("timestamp", "desc"),
          limit(1)
        );
        const querySnapshot = await getDocs(q);
        previousEntry = !querySnapshot.empty ? querySnapshot.docs[0].data() : null;
      } catch (firestoreReadError: any) {
        console.error(`[Firestore] Read error: ${firestoreReadError.message}`);
        return res.status(500).json({ error: `Firestore read failed: ${firestoreReadError.message}` });
      }

      // 3. Calculate Shift Score
      let shiftScore = null;
      if (previousEntry && previousEntry.rawData) {
        shiftScore = calculateShift(parsedData, previousEntry.rawData, screenType);
      }

      // 4. Store in Firestore
      const newEntry = {
        raceId,
        screenType,
        rawData: parsedData,
        shiftScore,
        timestamp: serverTimestamp(),
      };

      try {
        const docRef = await addDoc(collection(db, "odds_history"), newEntry);
        console.log(`[Firestore] Entry saved: ${docRef.id} for Race: ${raceId}`);
        res.status(200).json({
          success: true,
          id: docRef.id,
          received: {
            raceId,
            screenType,
            imageSize: image.length
          },
          firebase: {
            projectId: firebaseConfig.projectId,
            database: firebaseConfig.firestoreDatabaseId || "(default)"
          },
          timestamp: new Date().toISOString()
        });
      } catch (firestoreWriteError: any) {
        console.error(`[Firestore] Write error: ${firestoreWriteError.message}`);
        return res.status(500).json({ error: `Firestore write failed: ${firestoreWriteError.message}` });
      }

    } catch (error: any) {
      console.error("Critical error in /api/upload:", error);
      res.status(500).json({ error: `Internal server error: ${error.message}` });
    }
  });

  app.get("/api/history/:raceId", async (req, res) => {
    try {
      const { raceId } = req.params;
      const { screenType } = req.query;

      const q = query(
        collection(db, "odds_history"),
        where("raceId", "==", raceId),
        where("screenType", "==", screenType),
        orderBy("timestamp", "desc"),
        limit(50) // Adjust as needed
      );

      const querySnapshot = await getDocs(q);
      const history = querySnapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : data.timestamp
        };
      });

      res.json({ history: history.reverse() }); // Return in chronological order
    } catch (error: any) {
      console.error("Error fetching history:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Helper function to calculate shift
  function calculateShift(newData: any, oldData: any, type: string) {
    if (type === "ExactaMatrix") {
      const newMatrix = newData.matrix;
      const oldMatrix = oldData.matrix;
      if (!newMatrix || !oldMatrix) return null;
      
      // Calculate shift for each cell in the 10x10 matrix
      const shiftMatrix = newMatrix.map((row: any, i: number) => {
        const oldRow = oldMatrix[i] || {};
        const shiftRow: any = {};
        for (let j = 1; j <= 10; j++) {
          const colKey = j.toString();
          const newVal = parseFloat(row[colKey]) || 0;
          const oldVal = parseFloat(oldRow[colKey]) || 0;
          shiftRow[colKey] = newVal - oldVal;
        }
        return shiftRow;
      });
      return { matrix: shiftMatrix };
    } else {
      // WPS Pools logic
      if (!newData.horses || !oldData.horses) return null;
      const shift = newData.horses.map((newH: any) => {
        const oldH = oldData.horses.find((h: any) => h.number === newH.number) || { win: 0, place: 0, show: 0 };
        return {
          number: newH.number,
          win: newH.win - (oldH.win || 0),
          place: newH.place - (oldH.place || 0),
          show: newH.show - (oldH.show || 0)
        };
      });
      return { horses: shift };
    }
  }

  // Frontend Serving
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
