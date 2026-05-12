/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useMemo } from "react";
import {
  History,
  ChevronRight,
  TrendingUp,
  BarChart3,
  AlertCircle,
  RefreshCw,
  Clock,
  LayoutDashboard,
  ChevronDown,
  Info,
  Layers,
  CheckCircle2
} from "lucide-react";
import { motion } from "motion/react";
import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  getDocFromServer,
  doc,
  getDocsFromServer
} from "firebase/firestore";
import { db } from "./lib/firebase";
import { Toaster, toast } from "sonner";

type ScreenType = "ExactaMatrix" | "WPSPools";

interface OddsEntry {
  id: string;
  raceId: string;
  screenType: ScreenType;
  rawData: any;
  shiftScore: any;
  timestamp: string;
}

// Sparkline component for the grid cells
const Sparkline = ({ data, color }: { data: number[], color: string }) => {
  const chartData = useMemo(() => data.map((val, i) => ({ value: val, index: i })), [data]);

  return (
    <div className="h-6 w-full opacity-60">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <YAxis hide domain={['auto', 'auto']} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default function App() {
  const [screenType, setScreenType] = useState<ScreenType>("ExactaMatrix");
  const [raceId, setRaceId] = useState("");
  const [uploadResult, setUploadResult] = useState<any>(null);
  const [history, setHistory] = useState<OddsEntry[]>([]);

  const [error, setError] = useState<string | null>(null);

  const lastProcessedId = useRef<string | null>(null);

  // Connection Test
  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, '_connection_test', 'status'));
        console.log("Firebase connection verified.");
      } catch (error: any) {
        if (error.message?.includes('offline')) {
          toast.error("Firebase is offline. Check your network or config.");
        }
      }
    };
    testConnection();
  }, []);


  // Real-time Firestore listener (Filtered)
  useEffect(() => {
    if (!raceId) return;

    // Normalized query
    const tidiedRaceId = raceId.trim().toUpperCase();
    console.log(`Setting up filtered listener for: [${tidiedRaceId}] - [${screenType}]`);

    const q = query(
      collection(db, "odds_history"),
      where("raceId", "==", tidiedRaceId),
      where("screenType", "==", screenType),
      orderBy("timestamp", "desc"),
      limit(50)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      console.log(`Filtered sync: Found ${snapshot.size} records for ${tidiedRaceId}`);
      const data = snapshot.docs.map(doc => {
        const docData = doc.data();
        return {
          id: doc.id,
          ...docData,
          timestamp: docData.timestamp?.toDate()?.toISOString() || new Date().toISOString()
        };
      }) as OddsEntry[];

      const sortedData = data.reverse();
      setHistory(sortedData);

      if (sortedData.length > 0) {
        const latest = sortedData[sortedData.length - 1];
        setUploadResult(latest);

        // Detect if this is a NEW entry since the last one we saw
        if (lastProcessedId.current && lastProcessedId.current !== latest.id) {
          toast.success("New data received & processed successfully!", {
            description: `Update for ${raceId} (${screenType})`,
            icon: <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          });
        }
        lastProcessedId.current = latest.id;
      }
    }, (err) => {
      console.error("Firestore sync error:", err);
      toast.error("Real-time sync failed", {
        description: err.message
      });
    });

    return () => unsubscribe();
  }, [raceId, screenType]);

  const handleHardRefresh = async () => {
    toast.promise(async () => {
      const tidiedRaceId = raceId.trim().toUpperCase();
      const q = query(
        collection(db, "odds_history"),
        where("raceId", "==", tidiedRaceId),
        where("screenType", "==", screenType),
        orderBy("timestamp", "desc"),
        limit(1)
      );
      const snapshot = await getDocsFromServer(q);
      if (snapshot.empty) throw new Error("No data found on server for this race.");
      return snapshot.size;
    }, {
      loading: 'Hard fetching from server...',
      success: (size) => `Force-synced ${size} latest entry`,
      error: (err) => `Fetch failed: ${err.message}`
    });
  };

  // Helper to extract trend for a specific cell in the matrix
  const getMatrixTrend = (rowIndex: number, colIndex: number) => {
    const colKey = (colIndex + 1).toString();
    return history
      .filter(h => h.screenType === "ExactaMatrix" && h.rawData?.matrix)
      .map(h => {
        const row = h.rawData.matrix[rowIndex];
        return row ? (parseFloat(row[colKey]) || 0) : 0;
      })
      .slice(-10); // Last 10 entries
  };

  // Helper to extract trend for a specific horse pool
  const getPoolTrend = (horseNum: number, category: "win" | "place" | "show") => {
    return history
      .filter(h => h.screenType === "WPSPools" && h.rawData?.horses)
      .map(h => {
        const horse = h.rawData.horses.find((horse: any) => horse.number === horseNum);
        return horse ? horse[category] : 0;
      })
      .slice(-10);
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans">
      <Toaster position="top-center" richColors />

      {/* Top Navigation / Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row justify-between items-center py-4 gap-4">
            {/* Logo & Title */}
            <div className="flex items-center justify-between w-full sm:w-auto">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-md shadow-indigo-500/20">
                  <TrendingUp className="w-5 h-5 text-white" />
                </div>
                <span className="font-black tracking-tight text-xl text-slate-900">PROTrack</span>
              </div>

              {/* Mobile Live Indicator */}
              <div className="sm:hidden flex items-center gap-2 px-2.5 py-1 bg-emerald-50 border border-emerald-200 rounded-full">
                <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)] animate-pulse" />
                <span className="text-[9px] font-bold text-emerald-700 uppercase tracking-wider">Live</span>
              </div>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-3 w-full sm:w-auto">
              <div className="flex-1 sm:flex-none relative">
                <input
                  value={raceId}
                  onChange={(e) => setRaceId(e.target.value)}
                  className="w-full sm:w-48 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm font-bold text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 shadow-inner transition-all"
                  placeholder="Enter RACE-ID..."
                />
              </div>

              <div className="hidden sm:flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-xl">
                <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)] animate-pulse" />
                <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider">Live</span>
              </div>

              <button
                onClick={handleHardRefresh}
                className="p-2 hover:bg-slate-50 rounded-xl text-slate-600 transition-colors border border-slate-200 bg-white shadow-sm flex-shrink-0"
                title="Force Server Refresh"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
        <motion.div
          key="dashboard"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-6 sm:space-y-10"
        >
          {/* Dashboard Hero */}
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
            <div>
              <div className="flex items-center gap-2 text-indigo-600 text-xs font-bold uppercase tracking-widest mb-2">
                <Layers className="w-3 h-3" />
                <span>Real-time Odds Intelligence</span>
              </div>
              <h1 className="text-3xl sm:text-4xl md:text-5xl font-black tracking-tighter text-slate-900">
                {raceId || "NO RACE"} <span className="text-slate-400 ml-1 sm:ml-2 font-medium">/ Analysis</span>
              </h1>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between lg:justify-end w-full lg:w-auto gap-4 sm:gap-6">
              <div className="flex bg-slate-200/50 p-1 rounded-xl shadow-inner border border-slate-200 w-full sm:w-auto">
                {(["ExactaMatrix", "WPSPools"] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => setScreenType(type)}
                    className={`flex-1 sm:flex-none px-4 py-2 sm:py-1.5 rounded-lg text-xs font-bold transition-all ${screenType === type
                        ? "bg-white text-indigo-700 shadow-sm border border-slate-200/50"
                        : "text-slate-500 hover:text-slate-700 hover:bg-slate-100/50"
                      }`}
                  >
                    {type === "ExactaMatrix" ? "EXACTA" : "WPS POOLS"}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-4 sm:text-right">
                <div>
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-0.5">Samples Processed</p>
                  <p className="text-xl sm:text-2xl font-black text-slate-900 leading-none">{history.length}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Heatmap Grid for ExactaMatrix */}
          {screenType === "ExactaMatrix" && uploadResult?.rawData?.matrix && (
            <div className="bg-white border border-slate-200 rounded-3xl sm:rounded-[2.5rem] p-4 sm:p-8 shadow-xl shadow-slate-200/50 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-8 opacity-[0.02] pointer-events-none hidden sm:block">
                <BarChart3 className="w-64 h-64 rotate-12 text-slate-900" />
              </div>

              <div className="relative z-10">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-6 sm:mb-8">
                  <div className="flex flex-wrap gap-4 sm:gap-6">
                    <HeaderStat label="Screen" value="Exacta" icon={Info} />
                    <HeaderStat label="Refresh" value="Auto" icon={Clock} />
                  </div>
                  <div className="flex gap-3 sm:gap-4">
                    <LegendItem color="bg-emerald-100" label="Drop (Favor)" border="border-emerald-300" />
                    <LegendItem color="bg-rose-100" label="Rise (Risk)" border="border-rose-300" />
                  </div>
                </div>

                <div className="w-full overflow-x-auto custom-scrollbar pb-4 -mx-4 px-4 sm:mx-0 sm:px-0">
                  <div className="min-w-[700px] sm:min-w-[800px]">
                    <div className="grid grid-cols-11 gap-1.5 sm:gap-2.5">
                      {/* Y-Axis Label */}
                      <div className="col-span-1"></div>
                      {[...Array(10)].map((_, i) => (
                        <div key={i} className="text-center text-[9px] sm:text-[10px] font-black text-slate-500 uppercase">#{i + 1}</div>
                      ))}

                      {uploadResult.rawData.matrix.map((row: any, i: number) => (
                        <div key={i} className="contents">
                          <div className="flex items-center justify-end pr-2 sm:pr-4 text-[9px] sm:text-[10px] font-black text-slate-500 uppercase">#{i + 1}</div>
                          {[...Array(10)].map((_, j) => {
                            const colKey = (j + 1).toString();
                            const val = row[colKey] ?? null;
                            const shift = uploadResult.shiftScore?.matrix?.[i]?.[colKey] || 0;
                            const trend = getMatrixTrend(i, j);
                            return (
                              <motion.div
                                key={j}
                                whileHover={{ scale: 1.05, zIndex: 30 }}
                                className={`relative group h-16 sm:h-20 rounded-xl sm:rounded-2xl border transition-all duration-300 flex flex-col items-center justify-center overflow-hidden shadow-sm
                                  ${shift < 0 ? "bg-emerald-50 border-emerald-200" :
                                    shift > 0 ? "bg-rose-50 border-rose-200" :
                                      "bg-slate-50 border-slate-200 hover:bg-slate-100"}
                                `}
                              >
                                <span className={`text-sm sm:text-base font-black tracking-tighter ${shift < 0 ? "text-emerald-700" : shift > 0 ? "text-rose-700" : "text-slate-900"}`}>
                                  {val !== null ? val : "—"}
                                </span>

                                {shift !== 0 && (
                                  <span className={`text-[8px] sm:text-[9px] font-black mt-0.5 ${shift < 0 ? "text-emerald-600/80" : "text-rose-600/80"}`}>
                                    {shift < 0 ? shift.toFixed(1) : `+${shift.toFixed(1)}`}
                                  </span>
                                )}

                                {/* Sparkline in the background */}
                                <div className="absolute inset-x-1 sm:inset-x-2 bottom-1 sm:bottom-2">
                                  <Sparkline
                                    data={trend}
                                    color={shift < 0 ? "#10B981" : shift > 0 ? "#F43F5E" : "#94A3B8"}
                                  />
                                </div>
                              </motion.div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Pool Analysis for WPSPools */}
          {screenType === "WPSPools" && uploadResult?.rawData?.horses && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
              {uploadResult.rawData.horses.map((horse: any, idx: number) => {
                const shift = uploadResult.shiftScore?.horses?.find((h: any) => h.number === horse.number);
                return (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: idx * 0.05 }}
                    className="bg-white border border-slate-200 rounded-3xl p-5 sm:p-6 shadow-xl shadow-slate-200/40 space-y-5 sm:space-y-6 relative overflow-hidden group hover:border-indigo-300 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 sm:gap-4">
                        <div className="w-10 h-10 sm:w-12 sm:h-12 bg-slate-50 border border-slate-200 text-slate-900 rounded-full flex items-center justify-center text-lg sm:text-xl font-black shadow-sm">
                          {horse.number}
                        </div>
                        <div>
                          <h3 className="font-black text-base sm:text-lg text-slate-900">Runner Pool</h3>
                          <p className="text-[9px] sm:text-[10px] font-bold text-slate-500 uppercase tracking-widest">Active Entry</p>
                        </div>
                      </div>
                      <History className="w-4 h-4 sm:w-5 sm:h-5 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                    </div>

                    <div className="space-y-3 sm:space-y-4">
                      {(["win", "place", "show"] as const).map((cat) => {
                        const val = horse[cat] || 0;
                        const sVal = shift?.[cat] || 0;
                        const trend = getPoolTrend(horse.number, cat);

                        return (
                          <div key={cat} className="space-y-1.5 sm:space-y-2">
                            <div className="flex items-center justify-between px-1">
                              <span className="text-[9px] sm:text-[10px] font-black text-slate-500 uppercase tracking-widest italic">{cat}</span>
                              <div className="flex items-center gap-2">
                                <span className={`text-xs sm:text-sm font-mono font-black ${sVal > 0 ? "text-emerald-600" : sVal < 0 ? "text-rose-600" : "text-slate-900"}`}>
                                  ${val.toLocaleString()}
                                </span>
                                {sVal !== 0 && (
                                  <span className={`text-[7px] sm:text-[8px] font-black px-1.5 py-0.5 rounded-full border ${sVal > 0 ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200"}`}>
                                    {sVal > 0 ? `+${sVal}` : sVal}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="h-6 sm:h-8 w-full bg-slate-50 rounded-lg sm:rounded-xl overflow-hidden px-1 sm:px-2 pt-0.5 sm:pt-1 border border-slate-100">
                              <Sparkline
                                data={trend}
                                color={sVal > 0 ? "#10B981" : sVal < 0 ? "#F43F5E" : "#6366F1"}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}

          {!uploadResult ? (
            <div className="flex flex-col items-center justify-center p-12 sm:p-20 text-slate-500 bg-white rounded-3xl sm:rounded-[3rem] border border-slate-200 border-dashed shadow-sm text-center">
              <LayoutDashboard className="w-16 h-16 sm:w-20 sm:h-20 mb-4 sm:mb-6 text-slate-300" />
              <h3 className="text-lg sm:text-xl font-bold text-slate-600">Awaiting Dataset</h3>
              <p className="text-xs sm:text-sm mt-2 max-w-sm">Enter a Race ID and start the Python capture script on your computer to begin tracking.</p>
            </div>
          ) : screenType === "ExactaMatrix" && !uploadResult?.rawData?.matrix ? (
            <div className="flex flex-col items-center justify-center p-12 sm:p-20 text-rose-600 bg-rose-50 rounded-3xl sm:rounded-[3rem] border border-rose-200 border-dashed mt-8 shadow-sm text-center">
              <AlertCircle className="w-12 h-12 sm:w-16 sm:h-16 mb-4 text-rose-400" />
              <h3 className="text-lg sm:text-xl font-bold">No Matrix Data Found!</h3>
              <p className="text-xs sm:text-sm text-rose-600/80 max-w-md mt-2">
                The AI successfully received your screenshot, but it couldn't find the 10x10 matrix. Ensure the TwinSpires matrix is visible when the Python script captures the screen.
              </p>
            </div>
          ) : null}
        </motion.div>
      </main>
    </div>
  );
}

// Sub-components for cleaner code
const HeaderStat = ({ label, value, icon: Icon }: { label: string, value: string, icon: any }) => (
  <div className="flex items-center gap-2 sm:gap-3">
    <div className="w-6 h-6 sm:w-8 sm:h-8 rounded-lg sm:rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center">
      <Icon className="w-3 h-3 sm:w-4 sm:h-4 text-slate-500" />
    </div>
    <div>
      <p className="text-[8px] sm:text-[9px] font-black text-slate-500 uppercase tracking-widest leading-none mb-0.5 sm:mb-1">{label}</p>
      <p className="text-xs sm:text-sm font-bold text-slate-900 leading-none">{value}</p>
    </div>
  </div>
);

const LegendItem = ({ color, label, border }: { color: string, label: string, border: string }) => (
  <div className="flex items-center gap-1.5 sm:gap-2">
    <div className={`w-2 h-2 sm:w-3 sm:h-3 rounded-sm sm:rounded-md ${color} border ${border} shadow-sm`} />
    <span className="text-[8px] sm:text-[10px] font-bold text-slate-600 uppercase tracking-wider">{label}</span>
  </div>
);
