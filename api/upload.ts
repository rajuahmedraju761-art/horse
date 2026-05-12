import OpenAI from "openai";
import { initializeApp, getApps, getApp } from "firebase/app";
import { 
  getFirestore, 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  limit, 
  getDocs,
  serverTimestamp
} from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

// Initialize Firebase (Singleton pattern to prevent re-initialization on Vercel)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app, (firebaseConfig as any).firestoreDatabaseId);

// OpenAI will be initialized inside the handler

// Vercel Serverless Function Config
export const config = {
  maxDuration: 60,
  api: {
    bodyParser: {
      sizeLimit: '4.5mb',
    },
  },
};

export default async function handler(req: any, res: any) {
  // CORS configuration for Vercel
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { image, screenType, raceId: rawRaceId, race_id, raceID } = req.body;
    const raceId = (rawRaceId || race_id || raceID || "UNKNOWN")?.trim().toUpperCase();

    console.log(`[API] Upload attempt. Race: ${raceId}, Type: ${screenType}`);

    if (!image) {
      return res.status(400).json({ error: "Missing required field: 'image'. Expected base64 string." });
    }
    if (!screenType || !["ExactaMatrix", "WPSPools"].includes(screenType)) {
      return res.status(400).json({ error: "Invalid or missing 'screenType'. Must be 'ExactaMatrix' or 'WPSPools'." });
    }
    if (!raceId) {
      return res.status(400).json({ error: "Missing required field: 'raceId'." });
    }
    if (!process.env.OPENAI_API_KEY) {
      console.error("[API] OPENAI_API_KEY is missing!");
      return res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server." });
    }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

    let shiftScore = null;
    if (previousEntry && previousEntry.rawData) {
      shiftScore = calculateShift(parsedData, previousEntry.rawData, screenType);
    }

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
}

function calculateShift(newData: any, oldData: any, type: string) {
  if (type === "ExactaMatrix") {
    const newMatrix = newData.matrix;
    const oldMatrix = oldData.matrix;
    if (!newMatrix || !oldMatrix) return null;
    
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
