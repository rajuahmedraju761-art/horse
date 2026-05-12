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
  const [raceId, setRaceId] = useState("SAR-R9");
  const [uploadResult, setUploadResult] = useState<any>(null);
  const [history, setHistory] = useState<OddsEntry[]>([]);
  const [globalRecent, setGlobalRecent] = useState<any[]>([]); // New for debugging
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

  // Global activity listener (No filters) for debugging
  useEffect(() => {
    const q = query(
      collection(db, "odds_history"),
      orderBy("timestamp", "desc"),
      limit(20)
    );
    return onSnapshot(q, (snapshot) => {
      console.log(`Global sync: ${snapshot.size} entries total`);
      const data = snapshot.docs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id,
          raceId: d.raceId,
          screenType: d.screenType,
          timestamp: d.timestamp?.toDate()?.toLocaleTimeString() || "Pending..."
        };
      });
      setGlobalRecent(data);
    }, (err) => {
      console.error("Global Sync Error:", err);
      toast.error("Global Query Error", { description: err.message });
    });
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
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans selection:bg-indigo-500/30">
      <Toaster position="top-right" richColors />
      {/* Premium Sidebar Layout */}
      <div className="flex h-screen overflow-hidden">
        
        {/* Sidebar */}
        <aside className="w-64 bg-white border-r border-slate-200 flex flex-col shrink-0 shadow-sm z-10">
          <div className="p-6 flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <TrendingUp className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold tracking-tight text-lg text-slate-900">PROTrack</span>
          </div>

          <nav className="flex-1 px-4 py-4 space-y-2">
            <button
              className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all bg-indigo-50 text-indigo-700 border border-indigo-200/50 shadow-sm"
            >
              <LayoutDashboard className="w-4 h-4" />
              Dashboard
            </button>
          </nav>

          <div className="p-6 border-t border-slate-100">
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3 shadow-sm">
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                <span>Active Track</span>
                <ChevronDown className="w-3 h-3" />
              </div>
              <input 
                value={raceId}
                onChange={(e) => setRaceId(e.target.value)}
                className="w-full bg-transparent border-none focus:ring-0 text-sm font-bold text-slate-900 placeholder:text-slate-400 p-0"
                placeholder="RACE-ID"
              />
            </div>
          </div>

          {/* Global Recent Activity Feed (Debug Mode) */}
          <div className="p-4 mt-auto">
            <div className="bg-white rounded-2xl p-5 border border-slate-200 relative overflow-hidden group shadow-sm">
              <div className="absolute top-0 right-0 p-3 opacity-5 group-hover:opacity-10 transition-opacity">
                <RefreshCw className="w-8 h-8 animate-spin-slow text-slate-900" />
              </div>
              
              <div className="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-1 flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping" />
                Remote Sync Active
              </div>
              
              <div className="mb-4">
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-2xl font-black text-slate-900">{globalRecent.length}</p>
                    <p className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Images Received</p>
                  </div>
                  <button 
                    onClick={async () => {
                      toast.loading("Sending test payload...");
                      const res = await fetch("/api/upload", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          image: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", // Smallest transparent gif
                          screenType: "ExactaMatrix",
                          raceId: raceId || "TEST-RACE"
                        })
                      });
                      const data = await res.json();
                      if(res.ok) toast.success("Test ping successful!");
                      else toast.error("Test failed: " + data.error);
                    }}
                    className="text-[8px] bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded text-slate-700 font-bold transition-all border border-slate-200"
                  >
                    TEST PING
                  </button>
                </div>
              </div>

              <div className="space-y-3 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                {globalRecent.length === 0 ? (
                  <p className="text-[10px] text-slate-500 italic">Waiting for Python client...</p>
                ) : (
                  globalRecent.map(item => (
                    <div key={item.id} className="border-b border-slate-100 pb-2 last:border-0 cursor-pointer hover:bg-slate-50 transition-colors rounded-lg px-2 -mx-2 pt-2" onClick={() => {
                      setRaceId(item.raceId);
                      setScreenType(item.screenType);
                    }}>
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-[10px] font-bold text-indigo-600">{item.raceId}</span>
                        <span className="text-[8px] text-slate-500 font-mono">{item.timestamp}</span>
                      </div>
                      <p className="text-[9px] text-slate-600 flex items-center gap-1">
                        <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                        {item.screenType} Processed
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] overflow-y-auto">
          
          {/* Header */}
          <header className="h-16 border-b border-slate-200 flex items-center justify-between px-8 sticky top-0 bg-[#F8FAFC]/80 backdrop-blur-md z-20">
            <div className="flex items-center gap-6">
              <div className="flex bg-slate-200/50 p-1 rounded-xl shadow-inner border border-slate-200">
                {(["ExactaMatrix", "WPSPools"] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => setScreenType(type)}
                    className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      screenType === type 
                        ? "bg-white text-indigo-700 shadow-sm border border-slate-200/50" 
                        : "text-slate-500 hover:text-slate-700 hover:bg-slate-100/50"
                    }`}
                  >
                    {type === "ExactaMatrix" ? "EXACTA" : "WPS POOLS"}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-full shadow-sm">
                <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)] animate-pulse" />
                <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider">Live Connection</span>
              </div>
              <button 
                onClick={handleHardRefresh}
                className="p-2 hover:bg-slate-200 rounded-full text-slate-500 transition-colors"
                title="Force Server Refresh"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </header>

          {/* Dynamic Content */}
          <main className="p-8">
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-8"
            >
              {/* Dashboard Hero */}
              <div className="flex items-end justify-between">
                <div>
                  <div className="flex items-center gap-2 text-indigo-600 text-xs font-bold uppercase tracking-widest mb-2">
                    <Layers className="w-3 h-3" />
                    <span>Real-time Odds Intelligence</span>
                  </div>
                  <h1 className="text-4xl font-black tracking-tighter text-slate-900">
                    {raceId} <span className="text-slate-400 ml-2 font-medium">/ Track Analysis</span>
                  </h1>
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-1">Samples Processed</p>
                  <p className="text-2xl font-black text-slate-900">{history.length}</p>
                </div>
              </div>

              {/* Heatmap Grid for ExactaMatrix */}
              {screenType === "ExactaMatrix" && uploadResult?.rawData?.matrix && (
                <div className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-xl shadow-slate-200/50 relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-8 opacity-[0.03]">
                    <BarChart3 className="w-64 h-64 rotate-12 text-slate-900" />
                  </div>
                  
                  <div className="relative z-10">
                    <div className="flex items-center justify-between mb-8">
                      <HeaderStat label="Screen Type" value="Exacta" icon={Info} />
                      <HeaderStat label="Refresh Int." value="Dynamic" icon={Clock} />
                      <HeaderStat label="Algorithm" value="Shift-Delta" icon={TrendingUp} />
                      <div className="flex gap-4">
                        <LegendItem color="bg-emerald-100" label="Odds Drop (Favor)" border="border-emerald-300" />
                        <LegendItem color="bg-rose-100" label="Odds Rise (Risk)" border="border-rose-300" />
                      </div>
                    </div>

                    <div className="grid grid-cols-11 gap-2.5">
                      {/* Y-Axis Label */}
                      <div className="col-span-1"></div>
                      {[...Array(10)].map((_, i) => (
                        <div key={i} className="text-center text-[10px] font-black text-slate-500 uppercase">#{i+1}</div>
                      ))}

                      {uploadResult.rawData.matrix.map((row: any, i: number) => (
                        <div key={i} className="contents">
                          <div className="flex items-center justify-end pr-4 text-[10px] font-black text-slate-500 uppercase">#{i+1}</div>
                          {[...Array(10)].map((_, j) => {
                            const colKey = (j + 1).toString();
                            const val = row[colKey] ?? null;
                            const shift = uploadResult.shiftScore?.matrix?.[i]?.[colKey] || 0;
                            const trend = getMatrixTrend(i, j);
                            return (
                              <motion.div
                                key={j}
                                whileHover={{ scale: 1.05, zIndex: 30 }}
                                className={`relative group h-20 rounded-2xl border transition-all duration-300 flex flex-col items-center justify-center overflow-hidden shadow-sm
                                  ${shift < 0 ? "bg-emerald-50 border-emerald-200" : 
                                    shift > 0 ? "bg-rose-50 border-rose-200" : 
                                    "bg-slate-50 border-slate-200 hover:bg-slate-100"}
                                `}
                              >
                                <span className={`text-base font-black tracking-tighter ${shift < 0 ? "text-emerald-700" : shift > 0 ? "text-rose-700" : "text-slate-900"}`}>
                                  {val !== null ? val : "—"}
                                </span>
                                
                                {shift !== 0 && (
                                  <span className={`text-[9px] font-black mt-0.5 ${shift < 0 ? "text-emerald-600/80" : "text-rose-600/80"}`}>
                                    {shift < 0 ? shift.toFixed(1) : `+${shift.toFixed(1)}`}
                                  </span>
                                )}

                                {/* Sparkline in the background */}
                                <div className="absolute inset-x-2 bottom-2">
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
              )}

              {/* Pool Analysis for WPSPools */}
              {screenType === "WPSPools" && uploadResult?.rawData?.horses && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {uploadResult.rawData.horses.map((horse: any, idx: number) => {
                    const shift = uploadResult.shiftScore?.horses?.find((h: any) => h.number === horse.number);
                    return (
                      <motion.div
                        key={idx}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: idx * 0.05 }}
                        className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xl shadow-slate-200/40 space-y-6 relative overflow-hidden group hover:border-indigo-300 transition-colors"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-slate-50 border border-slate-200 text-slate-900 rounded-full flex items-center justify-center text-xl font-black shadow-sm">
                              {horse.number}
                            </div>
                            <div>
                              <h3 className="font-black text-lg text-slate-900">Runner Pool</h3>
                              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Active Entry</p>
                            </div>
                          </div>
                          <History className="w-5 h-5 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                        </div>

                        <div className="space-y-4">
                          {(["win", "place", "show"] as const).map((cat) => {
                            const val = horse[cat] || 0;
                            const sVal = shift?.[cat] || 0;
                            const trend = getPoolTrend(horse.number, cat);
                            
                            return (
                              <div key={cat} className="space-y-2">
                                <div className="flex items-center justify-between px-1">
                                  <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic">{cat}</span>
                                  <div className="flex items-center gap-2">
                                    <span className={`text-sm font-mono font-black ${sVal > 0 ? "text-emerald-600" : sVal < 0 ? "text-rose-600" : "text-slate-900"}`}>
                                      ${val.toLocaleString()}
                                    </span>
                                    {sVal !== 0 && (
                                      <span className={`text-[8px] font-black px-1.5 py-0.5 rounded-full border ${sVal > 0 ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200"}`}>
                                         {sVal > 0 ? `+${sVal}` : sVal}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="h-8 w-full bg-slate-50 rounded-xl overflow-hidden px-2 pt-1 border border-slate-100">
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
                <div className="flex flex-col items-center justify-center p-20 text-slate-500 bg-white rounded-[3rem] border border-slate-200 border-dashed shadow-sm">
                  <LayoutDashboard className="w-20 h-20 mb-6 text-slate-300" />
                  <h3 className="text-xl font-bold text-slate-600">Awaiting Dataset</h3>
                  <p className="text-sm">Enter a Race ID and start the Python capture script to begin tracking.</p>
                </div>
              ) : screenType === "ExactaMatrix" && !uploadResult?.rawData?.matrix ? (
                <div className="flex flex-col items-center justify-center p-20 text-rose-600 bg-rose-50 rounded-[3rem] border border-rose-200 border-dashed mt-8 shadow-sm">
                  <AlertCircle className="w-16 h-16 mb-4 text-rose-400" />
                  <h3 className="text-xl font-bold">No Matrix Data Found in Image!</h3>
                  <p className="text-sm text-rose-600/80 text-center max-w-md mt-2">
                    The AI successfully received your screenshot, but it couldn't find any 10x10 horse racing matrix in it. Are you sure the TwinSpires matrix is open and visible on your screen when the Python script captures it?
                  </p>
                </div>
              ) : null}
            </motion.div>
          </main>
        </div>
      </div>
    </div>
  );
}

// Sub-components for cleaner code
const HeaderStat = ({ label, value, icon: Icon }: { label: string, value: string, icon: any }) => (
  <div className="flex items-center gap-3">
    <div className="w-8 h-8 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center">
      <Icon className="w-4 h-4 text-slate-500" />
    </div>
    <div>
      <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">{label}</p>
      <p className="text-sm font-bold text-slate-900">{value}</p>
    </div>
  </div>
);

const LegendItem = ({ color, label, border }: { color: string, label: string, border: string }) => (
  <div className="flex items-center gap-2">
    <div className={`w-3 h-3 rounded-md ${color} border ${border} shadow-sm`} />
    <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">{label}</span>
  </div>
);
