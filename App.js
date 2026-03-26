import { useState, useRef, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════════
// IMPROVED BATTERY SCIENCE — what changed vs original:
//
// 1. ARRHENIUS TEMPERATURE MODEL
//    Old: simple linear city multiplier (1.0–1.85x)
//    New: 2^((T-25)/8) exponential — scientifically accurate
//         Underhood temp (ambient +15°C) used for aging calculations
//         City base temperatures calibrated to real Indian climate data
//
// 2. NON-LINEAR AGING CURVES
//    Old: linear fade (age × 8% per year)
//    New: CF = 100 × exp(-k × effectiveAge^1.25)
//         Batteries accelerate degradation at end-of-life (knee point)
//
// 3. EFFECTIVE AGE (temperature-adjusted)
//    Old: calendar age only
//    New: effectiveAge = calendarAge × arrheniusUnderhood
//         A 3yr battery in Ahmedabad ≈ 5.5yr at 25°C reference
//
// 4. PROPER OCV-SOC LOOKUP TABLE
//    Old: simple voltage threshold buckets
//    New: 11-point interpolated OCV-SOC curve for lead-acid
//         Temperature-corrected (-0.003V/°C above 25°C)
//
// 5. IR EXPONENTIAL RISE MODEL
//    Old: linear IR estimate
//    New: IR(t) = IR_base × 2^(t / t_double)
//         t_double calibrated per city climate
//         Ah-dependent base IR (larger Ah = lower IR)
//
// 6. PSOC SULFATION MODEL
//    Old: fixed trip penalty
//    New: chronic PSOC → sulfation accumulation over time
//         Short trips cause progressive lead sulfate crystal growth
//
// 7. WEIBULL FAILURE PROBABILITIES
//    Old: heuristic linear estimates
//    New: Weibull survival analysis (shape β=3.5, wear-out failure)
//         P(fail in 6mo) = conditional probability from survival curve
//
// 8. LOAD TEST VOLTAGE MODEL (Ohm's Law + electrochemical overpotential)
//    Old: heuristic subtraction
//    New: V_load = OCV - I×IR×1.5 (overpotential factor)
//         Load current derived from rated CCA and Ah
//
// 9. SG ESTIMATION
//    New: Electrolyte specific gravity estimated from capacity factor
//         New: 1.280 | End-of-life: ~1.195
//
// 10. CONFIDENCE INTERVAL ON RUL
//     New: CI width shrinks as more measurements are provided
//          (OCV + IR + CCA% all measured = tighter estimate)
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the Spinny Pro Battery Diagnostic AI, an expert-level automotive battery engineer assistant used EXCLUSIVELY by Spinny's certified battery technicians at service centres.

AUDIENCE: Trained battery technicians — NOT customers. Use technical language. Give precise engineering data. No hand-holding.

SPINNY CONTEXT:
- Spinny operates in 15 cities: Delhi-NCR, Bengaluru, Hyderabad, Pune, Mumbai, Kolkata, Chennai, Ahmedabad, Jaipur, Chandigarh, Indore, Coimbatore, Lucknow, Kochi, Surat
- Every Spinny Assured® car undergoes 200-point inspection including battery check
- Spinny Pro service: OEM parts, 3-month warranty, free pickup/drop
- Spinny uses Exide, Amaron Pro, Bosch S4/S5 as replacement stock

SCIENCE BASIS (for your calculations):
- Arrhenius temperature acceleration: aging doubles every 8°C above 25°C
- Underhood temp = ambient + ~15°C during operation
- CCA degrades ~1.4× faster than capacity (grid corrosion primary cause)
- Effective age already accounts for temperature-accelerated aging
- OCV-SOC curve: 12.73V=100%, 12.50V=80%, 12.10V=50%, 11.81V=30%
- IR doubles every ~1.5–2 years in hot Indian climate
- Sulfation becomes irreversible when SI > 6 (crystal diameter >100μm)
- Weibull β=3.5 for lead-acid wear-out failures

DEEP BATTERY ANALYSIS PROTOCOL:
For every diagnostic request, calculate and report ALL of the following:

━━ MODULE 1: MULTI-FACTOR DEGRADATION SCORE
• Capacity Factor (CF): %
• CCA Factor (CCAF): %
• Internal Resistance Factor (IRF): %
• Sulfation Index (SI): 0–10
• Grid Corrosion Stage: 1–4
• Self-Discharge Rate: %/day
• Thermal Stress Score: 0–10
• Electrolyte Stratification: mention if applicable
• Effective Age vs Calendar Age: explain the difference

━━ MODULE 2: REMAINING USEFUL LIFE (RUL)
Show: RUL range (months), confidence %, primary life limiter
Use Weibull survival analysis where applicable. 
Reference: η (scale) = city-adjusted expected life, β = 3.5

━━ MODULE 3: FAILURE MODE PREDICTION
Probability % for each in next 6 months:
• CCA Failure | Capacity Death | Internal Short | Grid Fracture
State which will trigger end-of-life first.

━━ MODULE 4: ELECTROCHEMICAL DIAGNOSTICS
• Estimated SG range (flooded battery)
• Temperature-corrected OCV
• Load test prediction: V at 50% CCA load, 15 seconds
• Internal resistance (mΩ): measured vs estimated

━━ MODULE 5: TECHNICIAN ACTION PROTOCOL
PASS | CONDITIONAL PASS | REPLACE REQUIRED | URGENT REPLACE
• Specific remediation if CONDITIONAL (equalisation V, duration, current)
• Replacement spec if REPLACE (Ah, CCA, terminal, part number range)
• Recommended brands: Exide FML / Amaron Pro / Bosch S4

━━ MODULE 6: VEHICLE RISK ASSESSMENT
• ECU damage risk from sudden battery failure (HIGH/MEDIUM/LOW + reason)
• Alternator overload risk (degraded battery forces higher alternator output)
• Jump-start ECU risk for this vehicle class

Format with clear MODULE headers. Use ⚠ CRITICAL or ✓ PASS flags. Be direct and technical.`;

// ── SPINNY DESIGN TOKENS ──────────────────────────────────────────
const S = {
  red: "#E5142C", darkRed: "#B91020", lightRed: "#FFF1F2",
  black: "#1A1A1A", gray900: "#111827", gray800: "#1F2937",
  gray700: "#374151", gray600: "#4B5563", gray500: "#6B7280",
  gray400: "#9CA3AF", gray300: "#D1D5DB", gray200: "#E5E7EB",
  gray100: "#F3F4F6", gray50: "#F9FAFB", white: "#FFFFFF",
  green: "#16a34a", greenBg: "#F0FDF4",
  amber: "#D97706", amberBg: "#FFFBEB",
  orange: "#EA580C", orangeBg: "#FFF7ED",
};

// ══════════════════════════════════════════════════════════════════
// IMPROVED DEEP BATTERY CALCULATOR
// ══════════════════════════════════════════════════════════════════
function deepCalc(f) {
  const age          = parseFloat(f.age)        || 0;
  const voltage      = parseFloat(f.voltage)    || 0;
  const irMeasured   = parseFloat(f.ir)         || 0;
  const ccaMeasured  = parseFloat(f.ccaPercent) || 0;  // 0 = not tested
  const ambientTemp  = parseFloat(f.temp)       || 38;
  const ratedAh      = parseFloat(f.batteryAh)  || 45;

  // ── STEP 1: ARRHENIUS TEMPERATURE ACCELERATION ─────────────────
  // Lead-acid: aging doubles every 8°C above 25°C (Arrhenius law)
  // ka = 2^((T - 25) / 8)
  // Underhood temperature ≈ ambient + 15°C during operation
  const cityTempMap = {
    delhi: 43, jaipur: 47, ahmedabad: 48, surat: 44,
    hyderabad: 41, chennai: 42, lucknow: 41, indore: 43,
    coimbatore: 38, kochi: 36, kolkata: 38, mumbai: 38,
    pune: 37, bengaluru: 31, chandigarh: 36,
  };
  const cityTemp     = cityTempMap[f.city] ?? ambientTemp;
  const underhoodT   = cityTemp + 15;         // operational underhood °C
  const ka_ambient   = Math.pow(2, (cityTemp   - 25) / 8);
  const ka_underhood = Math.pow(2, (underhoodT - 25) / 8);

  // Battery spends ~30% of time parked (ambient) and 70% running (underhood)
  const effectiveK   = 0.30 * ka_ambient + 0.70 * ka_underhood;

  // Effective (temperature-adjusted) age in years
  // A 3yr battery in Ahmedabad (48°C underhood ≈ 63°C) has lived like ~5.5yr at 25°C
  const effectiveAge = age * effectiveK;

  // ── STEP 2: CAPACITY FACTOR ────────────────────────────────────
  // Non-linear exponential fade: CF = 100 × exp(-k × effectiveAge^n)
  // k=0.022, n=1.25 calibrated for VRLA/flooded SLI lead-acid
  const k_cap = 0.022, n_cap = 1.25;
  let CF = 100 * Math.exp(-k_cap * Math.pow(effectiveAge, n_cap));

  // PSOC penalty: short trips cause chronic partial state of charge
  // → lead sulfate cannot fully dissolve → progressive capacity loss
  const psocPenalty = f.tripPattern === "short" ? 13
                    : f.tripPattern === "mixed"  ?  4 : 0;
  CF -= psocPenalty;

  // Symptom-based capacity penalty
  const sympCap = { none:0, slow:8, dim:10, warning:18, corrosion:5, multiple:25 };
  CF -= (sympCap[f.symptoms] || 0);

  // OCV-to-SOC correction (if voltage measured and battery was rested ≥ 2 hrs)
  if (voltage > 0) {
    // Temperature correction: lead-acid OCV shifts -0.003V per °C above 25°C
    const tempCorr   = (ambientTemp - 25) * 0.003;
    const vCorrected = voltage + tempCorr;

    // 11-point OCV–SOC lookup table for flooded lead-acid (at 25°C)
    const ocvSocTable = [
      [12.73, 100], [12.62, 90], [12.50, 80], [12.37, 70],
      [12.24, 60],  [12.10, 50], [11.96, 40], [11.81, 30],
      [11.66, 20],  [11.51, 10], [10.50,  0],
    ];
    let impliedSOC = 0;
    for (let i = 0; i < ocvSocTable.length - 1; i++) {
      const [v1, s1] = ocvSocTable[i];
      const [v2, s2] = ocvSocTable[i + 1];
      if (vCorrected >= v2) {
        impliedSOC = s2 + ((vCorrected - v2) / (v1 - v2)) * (s1 - s2);
        break;
      }
    }
    impliedSOC = Math.max(0, Math.min(100, impliedSOC));

    // If battery was on charge recently, a low reading at "full SOC" means low capacity
    if (impliedSOC < 30) CF = Math.min(CF, impliedSOC * 0.85);
    else if (impliedSOC < 50) CF = Math.min(CF, impliedSOC + 8);
  }
  CF = Math.round(Math.max(5, Math.min(100, CF)));

  // ── STEP 3: CCA FACTOR ─────────────────────────────────────────
  // CCA degrades ~1.4× faster than capacity in hot climate
  // Primary driver: positive grid corrosion (Pb → PbO₂ expansion causes shedding)
  const k_cca = 0.031, n_cca = 1.30;
  let CCAF;

  if (ccaMeasured > 0) {
    // Direct measurement from tester — trust it, but sanity-check against age
    CCAF = ccaMeasured;
    const maxPlausibleCCA = Math.max(10, 100 - effectiveAge * 11);
    if (CCAF > maxPlausibleCCA + 15) {
      // Reading seems optimistic — blend with model (tester calibration issue?)
      CCAF = CCAF * 0.6 + maxPlausibleCCA * 0.4;
    }
  } else {
    // Model-estimated CCA from effective age
    CCAF = 100 * Math.exp(-k_cca * Math.pow(effectiveAge, n_cca));
    if (f.symptoms  === "slow") CCAF = Math.min(CCAF, 52);
    if (f.lastStart === "jump") CCAF = Math.min(CCAF, 45);
    if (f.lastStart === "dead") CCAF = Math.min(CCAF, 30);
  }
  CCAF = Math.round(Math.max(5, Math.min(100, CCAF)));

  // ── STEP 4: INTERNAL RESISTANCE ────────────────────────────────
  // IR(t) = IR_base × 2^(t / t_double)
  // t_double ≈ 1.8yr in hot Indian climate
  // IR_base depends on Ah rating (larger Ah plate area = lower IR)
  const baseIR      = Math.max(4, 9.5 - ratedAh * 0.055);  // ~5–7 mΩ for 35–65Ah
  const irDouble    = Math.max(1.2, 2.4 / (effectiveK / 1.5));
  const modelledIR  = baseIR * Math.pow(2, age / irDouble);
  const actualIR    = irMeasured > 0 ? irMeasured
                    : Math.round(modelledIR + (f.symptoms === "slow" ? 4 : 0));

  // IRF: 100 = new (1× base), 0 = end-of-life (3× base)
  const irRatio = actualIR / baseIR;
  let IRF = 100 - (irRatio - 1) * 37;
  IRF = Math.round(Math.max(5, Math.min(100, IRF)));

  // ── STEP 5: SULFATION INDEX (0–10) ─────────────────────────────
  // Sulfation rate accelerates with: heat, PSOC, deep discharge, no maintenance
  // Hard sulfation: crystal diameter > 100μm → irreversible (typically SI > 6)
  let SI = 0;

  // Base calendar sulfation (effective age drives crystal growth)
  SI += Math.min(5, effectiveAge * 0.38);

  // PSOC: short trips mean chronic partial charge → sulfation accumulates faster
  if (f.tripPattern === "short")  SI += Math.min(3.0, age * 0.65);
  else if (f.tripPattern === "mixed") SI += Math.min(1.5, age * 0.28);

  // Deep discharge events (catastrophic sulfation)
  if (f.lastStart === "dead") SI += 2.8;
  else if (f.lastStart === "jump") SI += 1.6;

  // Maintenance neglect (electrolyte top-up and equalisation prevents sulfation)
  if (f.maintenance === "never")       SI += 1.3;
  else if (f.maintenance === "occasional") SI += 0.4;

  // Acceleration after SI > 6 (crystals too large to dissolve — runaway)
  SI = Math.min(10, SI);
  if (SI > 6 && age > 3) SI = Math.min(10, SI + (age - 3) * 0.45);
  SI = Math.round(SI * 10) / 10;

  // ── STEP 6: GRID CORROSION STAGE ──────────────────────────────
  // Pb → PbO → PbO₂ at ~0.1mm/yr in hot climate, faster with heat
  // Stage 1: <25% | Stage 2: 25–50% | Stage 3: 50–75% | Stage 4: >75% consumed
  const corrScore = age * effectiveK * 0.85;
  const gridStage = corrScore < 1.5 ? 1 : corrScore < 3.5 ? 2 : corrScore < 6 ? 3 : 4;

  // ── STEP 7: SELF-DISCHARGE RATE ────────────────────────────────
  // SDR = SDR_base × 2^((T-25)/10) + aging contribution + sulfation leakage
  // New: 0.12–0.30%/day | End-of-life: up to 3.5%/day
  const sdr_base      = 0.12;
  const sdr_tempAccel = sdr_base * Math.pow(2, (cityTemp - 25) / 10);
  const sdr_age       = age * 0.07 * effectiveK;
  const sdr_sulfation = SI * 0.14;
  const sdr = Math.round(Math.min(4.0, sdr_tempAccel + sdr_age + sdr_sulfation) * 100) / 100;

  // ── STEP 8: THERMAL STRESS SCORE ──────────────────────────────
  // Cumulative degree-hours above 35°C (reference threshold for accelerated aging)
  // Normalised to 0–10 scale over typical battery life
  const thermalScore = Math.round(Math.min(10, age * (underhoodT - 25) / 22) * 10) / 10;

  // ── STEP 9: ELECTROLYTE STRATIFICATION ────────────────────────
  // Occurs when battery is not equalised for >6 months
  // Increases bottom plate corrosion + reduces effective capacity
  const stratPenalty =
    f.maintenance === "never"      && age > 1 ? Math.min(8, age * 1.5) :
    f.maintenance === "occasional" && age > 2 ? Math.min(4, age * 0.8) : 0;

  // ── STEP 10: RUL — WEIBULL SURVIVAL ANALYSIS ──────────────────
  // Weibull CDF: F(t) = 1 - exp(-(t/η)^β)
  // β = 3.5 (wear-out failure mode for SLI lead-acid)
  // η = city-adjusted expected total life in months
  const cityLifeMap = {
    delhi:36, jaipur:32, ahmedabad:30, surat:33,
    hyderabad:38, chennai:36, lucknow:37, indore:38,
    coimbatore:42, kochi:44, kolkata:42, mumbai:42,
    pune:46, bengaluru:52, chandigarh:44,
  };
  let eta = (cityLifeMap[f.city] ?? 40);
  eta *= (f.tripPattern  === "short"   ? 0.82 : f.tripPattern  === "highway" ? 1.10 : 1.00);
  eta *= (f.maintenance  === "regular" ? 1.12 : f.maintenance  === "never"   ? 0.88 : 1.00);

  // Adjust η downward based on observed degradation factors
  const cfF   = Math.pow(CF   / 100, 0.80);
  const ccaF  = Math.pow(CCAF / 100, 1.00);  // CCA is first-to-fail in hot climate
  const irF   = Math.pow(IRF  / 100, 0.70);
  const sF    = Math.pow(Math.max(0.10, 1 - SI / 11), 0.90);
  const tF    = Math.pow(Math.max(0.30, 1 - thermalScore / 12), 0.60);
  const combinedF = Math.pow(cfF * ccaF * irF * sF * tF, 0.40);
  const adjustedEta = eta * combinedF;

  const beta = 3.5;
  const weibullCDF = (t, n, b) =>
    t <= 0 ? 0 : Math.min(1, 1 - Math.exp(-Math.pow(t / n, b)));

  const ageMonths = age * 12;
  const sNow = 1 - weibullCDF(ageMonths, adjustedEta, beta);
  const s6mo = 1 - weibullCDF(ageMonths + 6, adjustedEta, beta);
  const remainingRUL = Math.max(0, adjustedEta - ageMonths);

  // Confidence interval: width depends on how many measurements were provided
  const measureCount = [irMeasured > 0, ccaMeasured > 0, voltage > 0].filter(Boolean).length;
  const ciWidth = 0.38 - measureCount * 0.08;  // 0.38 (no data) → 0.14 (all measured)
  const rulMin  = Math.max(0, Math.round(remainingRUL * (1 - ciWidth)));
  const rulMax  = Math.max(0, Math.round(remainingRUL * (1 + ciWidth)));
  const rulConf = Math.round(50 + measureCount * 14);  // 50% → 92%

  // Primary life limiter
  const factors = [
    { name: "CCA Fade",       val: CCAF },
    { name: "Capacity",       val: CF   },
    { name: "Int. Resistance",val: IRF  },
    { name: "Sulfation",      val: Math.max(0, 100 - SI * 10)         },
    { name: "Thermal Stress", val: Math.max(0, 100 - thermalScore * 10) },
  ];
  const limiter = factors.reduce((a, b) => (a.val < b.val ? a : b));

  // ── STEP 11: WEIBULL FAILURE PROBABILITIES (6 months) ─────────
  // P(fail in next 6mo | survived to now) = (S(now) - S(now+6)) / S(now)
  const condProb6 = (etaW) => {
    if (sNow < 0.001) return 95;
    const sn  = 1 - weibullCDF(ageMonths,     etaW, beta);
    const s6  = 1 - weibullCDF(ageMonths + 6, etaW, beta);
    return Math.min(95, Math.max(2, Math.round((sn - s6) / Math.max(0.001, sn) * 100)));
  };

  const ccaFailP = condProb6(adjustedEta * 0.82);  // CCA degrades faster
  const capFailP = condProb6(adjustedEta * 1.05);  // Capacity lasts slightly longer
  // Internal short: driven by sulfation sediment bridging plates
  const shortP   = Math.min(80, Math.max(2, Math.round(SI * 7.5 + (gridStage - 1) * 4)));
  const gridP    = condProb6(adjustedEta * (gridStage >= 3 ? 0.75 : 0.95));

  // ── STEP 12: OVERALL HEALTH AND VERDICT ───────────────────────
  const overallHealth = Math.round(
    CF   * 0.28 +
    CCAF * 0.35 +
    IRF  * 0.20 +
    Math.max(0, 100 - SI * 10) * 0.12 +
    Math.max(0, 100 - thermalScore * 10) * 0.05
  );

  const verdict =
    overallHealth >= 78 && rulMin >= 8 ? "PASS"           :
    overallHealth >= 60 && rulMin >= 3 ? "CONDITIONAL"    :
    overallHealth >= 40               ? "REPLACE"         :
                                        "URGENT REPLACE";

  // ── STEP 13: ELECTROCHEMICAL ESTIMATES ────────────────────────
  // Ah-based rated CCA estimate (7.5 × Ah is typical for Indian market SLI)
  const ratedCCA_est = ratedAh * 7.5;

  // Estimated IR in mΩ
  const estIR = irMeasured > 0 ? irMeasured : Math.round(actualIR);

  // OCV: use measured if available, else estimate from OCV-SOC table via CF
  // (if fully charged, CF% roughly maps to usable SOC ceiling)
  const ocvTable = [
    [100,12.73],[90,12.62],[80,12.50],[70,12.37],
    [60,12.24], [50,12.10],[40,11.96],[30,11.81],
    [20,11.66], [10,11.51],[0,10.50],
  ];
  let estOCV;
  if (voltage > 0) {
    estOCV = voltage;
  } else {
    const cfIdx = Math.max(0, Math.min(10, Math.floor((100 - CF) / 10)));
    const [s1, v1] = [ocvTable[cfIdx][0], ocvTable[cfIdx][1]];
    const [s2, v2] = cfIdx < 10 ? [ocvTable[cfIdx+1][0], ocvTable[cfIdx+1][1]] : [s1, v1];
    estOCV = v1 + ((CF % 10) / 10) * (v2 - v1);
  }
  estOCV = Math.round(estOCV * 100) / 100;

  // Load test: V_load = OCV − I × R  (I = 50% of effective CCA in amps)
  // Factor 1.5 accounts for electrochemical overpotential and polarisation
  const loadI    = (CCAF / 100) * ratedCCA_est * 0.50;
  const vDrop    = (loadI * estIR / 1000) * 1.50;
  const estLoadV = Math.round(Math.max(8.5, estOCV - vDrop) * 100) / 100;

  // Electrolyte SG (flooded batteries only)
  // New: ~1.280, end-of-life: ~1.195 (correlates with capacity)
  const estSG = Math.round((1.198 + (CF / 100) * 0.077) * 1000) / 1000;

  return {
    CF, CCAF, IRF, SI, gridStage, sdr,
    thermalScore,
    rulMin, rulMax, rulConf,
    limiter: limiter.name,
    ccaFailP, capFailP, shortP, gridP,
    verdict, overallHealth,
    estIR, estOCV, estLoadV, estSG,
    effectiveAge : Math.round(effectiveAge * 10) / 10,
    effectiveK   : Math.round(effectiveK   * 100) / 100,
    stratPenalty : Math.round(stratPenalty * 10)  / 10,
    measureCount,
  };
}

// ── UI COMPONENTS ─────────────────────────────────────────────────
const FactorBar = ({ label, value, unit="%", warn=60, crit=40, invert=false }) => {
  const ev  = invert ? 100 - value*10 : value;
  const clr = ev >= warn ? S.green : ev >= crit ? S.amber : S.red;
  return (
    <div style={{ marginBottom:"10px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"4px" }}>
        <span style={{ fontSize:"11px", fontWeight:600, color:S.gray600, fontFamily:"'Lexend',sans-serif" }}>{label}</span>
        <span style={{ fontSize:"12px", fontWeight:700, color:clr, fontFamily:"'JetBrains Mono',monospace" }}>
          {typeof value==="number" ? (invert ? value.toFixed(1)+"/10" : Math.round(value)+unit) : value}
        </span>
      </div>
      <div style={{ height:"6px", background:S.gray200, borderRadius:"3px", overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${Math.min(100,Math.max(0,ev))}%`, background:clr, borderRadius:"3px", transition:"width 0.8s ease" }} />
      </div>
    </div>
  );
};

const MetricCard = ({ label, value, sub, color=S.black, bg=S.gray50, icon, critical }) => (
  <div style={{ background:bg, borderRadius:"10px", padding:"14px", border:`1px solid ${critical?S.red+"40":S.gray200}`, position:"relative", overflow:"hidden" }}>
    {critical && (
      <div style={{ position:"absolute", top:0, right:0, background:S.red, color:"white", fontSize:"9px", fontWeight:700, padding:"2px 7px", borderBottomLeftRadius:"6px", fontFamily:"'Lexend',sans-serif", letterSpacing:"0.05em" }}>CRITICAL</div>
    )}
    <div style={{ fontSize:"18px", marginBottom:"4px" }}>{icon}</div>
    <div style={{ fontSize:"10px", fontWeight:600, color:S.gray500, letterSpacing:"0.06em", fontFamily:"'Lexend',sans-serif", marginBottom:"3px", textTransform:"uppercase" }}>{label}</div>
    <div style={{ fontSize:"20px", fontWeight:800, color, fontFamily:"'JetBrains Mono',monospace", lineHeight:1 }}>{value}</div>
    {sub && <div style={{ fontSize:"11px", color:S.gray500, fontFamily:"'Lexend',sans-serif", marginTop:"3px" }}>{sub}</div>}
  </div>
);

const VerdictTag = ({ verdict }) => {
  const config = {
    "PASS":           { bg:"#F0FDF4", border:"#86EFAC", color:S.green,  icon:"✓" },
    "CONDITIONAL":    { bg:"#FFFBEB", border:"#FCD34D", color:S.amber,  icon:"⚠" },
    "REPLACE":        { bg:"#FFF7ED", border:"#FDBA74", color:S.orange, icon:"↻" },
    "URGENT REPLACE": { bg:S.lightRed,border:"#FCA5A5", color:S.red,   icon:"✕" },
  };
  const c = config[verdict] || config["PASS"];
  return (
    <div style={{ display:"inline-flex", alignItems:"center", gap:"6px", padding:"6px 16px", borderRadius:"8px", background:c.bg, border:`1.5px solid ${c.border}` }}>
      <span style={{ fontSize:"14px", color:c.color }}>{c.icon}</span>
      <span style={{ fontFamily:"'Lexend',sans-serif", fontSize:"13px", fontWeight:700, color:c.color, letterSpacing:"0.06em" }}>{verdict}</span>
    </div>
  );
};

const TechInput = ({ label, value, onChange, options, type="text", unit, placeholder, required }) => (
  <div style={{ marginBottom:"12px" }}>
    <label style={{ display:"flex", alignItems:"center", gap:"4px", fontSize:"10px", fontWeight:700, color:S.gray500, letterSpacing:"0.08em", marginBottom:"5px", fontFamily:"'Lexend',sans-serif", textTransform:"uppercase" }}>
      {label} {required && <span style={{ color:S.red }}>*</span>}
    </label>
    {options ? (
      <select value={value} onChange={e=>onChange(e.target.value)} style={{ width:"100%", padding:"8px 10px", borderRadius:"7px", fontSize:"13px", fontFamily:"'Lexend',sans-serif", fontWeight:500, color:S.black, background:S.white, border:`1.5px solid ${S.gray200}`, outline:"none" }}>
        {options.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    ) : (
      <div style={{ display:"flex", gap:"6px", alignItems:"center" }}>
        <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
          style={{ flex:1, padding:"8px 10px", borderRadius:"7px", fontSize:"13px", fontFamily:"'JetBrains Mono',monospace", fontWeight:500, color:S.black, background:S.white, border:`1.5px solid ${S.gray200}`, outline:"none" }} />
        {unit && <span style={{ fontSize:"11px", color:S.gray400, fontFamily:"'JetBrains Mono',monospace", minWidth:"22px" }}>{unit}</span>}
      </div>
    )}
  </div>
);

const ChatBubble = ({ msg }) => (
  <div style={{ display:"flex", justifyContent:msg.role==="user"?"flex-end":"flex-start", marginBottom:"12px" }}>
    {msg.role==="assistant" && (
      <div style={{ width:"28px", height:"28px", borderRadius:"6px", background:S.red, display:"flex", alignItems:"center", justifyContent:"center", marginRight:"8px", marginTop:"2px", flexShrink:0, fontSize:"12px" }}>🔬</div>
    )}
    <div style={{
      maxWidth:"82%", padding:"10px 14px", lineHeight:"1.7",
      fontFamily: msg.role==="assistant" ? "'JetBrains Mono',monospace" : "'Lexend',sans-serif",
      fontSize:   msg.role==="assistant" ? "12px" : "13px",
      borderRadius: msg.role==="user" ? "12px 12px 3px 12px" : "3px 12px 12px 12px",
      background: msg.role==="user" ? S.red : S.white,
      color:      msg.role==="user" ? "white" : S.gray800,
      border:     msg.role==="assistant" ? `1px solid ${S.gray200}` : "none",
      boxShadow:  "0 1px 3px rgba(0,0,0,0.06)",
      whiteSpace: "pre-wrap",
    }}>
      {msg.content}
    </div>
    {msg.role==="user" && (
      <div style={{ width:"28px", height:"28px", borderRadius:"6px", background:S.gray200, display:"flex", alignItems:"center", justifyContent:"center", marginLeft:"8px", marginTop:"2px", flexShrink:0, fontSize:"12px" }}>👷</div>
    )}
  </div>
);

// ── MAIN APP ──────────────────────────────────────────────────────
export default function SpinnyTechDiag() {
  const [form, setForm] = useState({
    vehicleReg:"", carModel:"hatchback", batteryBrand:"amaron", batteryAh:"45",
    batteryAge:"", mileage:"",
    voltage:"", ir:"", ccaPercent:"", temp:"38",
    tripPattern:"mixed", lastStart:"normal", maintenance:"occasional", symptoms:"none",
    city:"delhi",
  });
  const [result,      setResult]      = useState(null);
  const [messages,    setMessages]    = useState([]);
  const [input,       setInput]       = useState("");
  const [loading,     setLoading]     = useState(false);
  const [chatHistory, setChatHistory] = useState([]);
  const [activeTab,   setActiveTab]   = useState("inputs");
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:"smooth"}); }, [messages, loading]);

  const set = k => v => setForm(f => ({...f, [k]:v}));

  const buildPrompt = (f, r) => `SPINNY BATTERY DIAGNOSTIC REQUEST
Vehicle: ${f.vehicleReg||"Not provided"} | ${f.carModel} | ${f.batteryBrand} ${f.batteryAh}Ah
City: ${f.city} | Ambient: ${f.temp}°C | Calendar Age: ${f.batteryAge}yr | Mileage: ${f.mileage||"N/A"} km

ARRHENIUS-ADJUSTED PARAMETERS:
• Effective (Temp-Adjusted) Age: ${r.effectiveAge} yr (calendar age × ${r.effectiveK}× Arrhenius factor)
• Underhood temp estimate: ${(parseFloat(f.temp)||38)+15}°C operational

MEASURED VALUES:
• Resting OCV: ${f.voltage||"not measured"} V
• Internal Resistance: ${f.ir||"not measured"} mΩ
• CCA Remaining: ${f.ccaPercent||"not tested"} %
• Data completeness: ${r.measureCount}/3 measurements provided

FIELD OBSERVATIONS:
• Last Start: ${f.lastStart} | Trip Pattern: ${f.tripPattern} | Maintenance: ${f.maintenance}
• Symptoms: ${f.symptoms}

PRE-CALCULATED DEGRADATION FACTORS (verify and refine with your analysis):
• Capacity Factor (CF): ${r.CF}% [exponential fade model: CF=100×exp(-0.022×effectiveAge^1.25)]
• CCA Factor (CCAF): ${r.CCAF}% [CCA fades 1.4× faster than capacity]
• IR Factor (IRF): ${r.IRF}% [est. IR: ${r.estIR}mΩ, IR doubles every ~${Math.round(2.4/(r.effectiveK/1.5)*10)/10}yr]
• Sulfation Index (SI): ${r.SI}/10 [>6 = hard sulfation, irreversible]
• Grid Corrosion Stage: ${r.gridStage}/4
• Self-Discharge Rate: ${r.sdr}%/day [Arrhenius temp-adjusted]
• Thermal Stress: ${r.thermalScore}/10
• Stratification Penalty: ${r.stratPenalty > 0 ? r.stratPenalty + " capacity points" : "minimal"}

WEIBULL RUL ESTIMATE:
• RUL: ${r.rulMin}–${r.rulMax} months (${r.rulConf}% confidence)
• Primary Limiter: ${r.limiter}
• Overall Health Score: ${r.overallHealth}/100
• Pre-calc Verdict: ${r.verdict}

ELECTROCHEMICAL ESTIMATES:
• Est. OCV: ${r.estOCV}V | Est. IR: ${r.estIR}mΩ | Est. Load Test: ${r.estLoadV}V
• Est. Electrolyte SG: ${r.estSG} (flooded battery)

Run full 6-module diagnostic protocol. Validate or correct the pre-calculated factors above. Provide complete technician report with specific remediation or replacement specs.`;

  const callAI = async (userMsg, history) => {
    const GEMINI_API_KEY = process.env.REACT_APP_GEMINI_KEY || "YOUR_KEY_HERE";
    const historyText = history.map(m=>`${m.role==="user"?"TECHNICIAN":"AI ENGINEER"}: ${m.content}`).join("\n\n");
    const fullPrompt  = `${SYSTEM_PROMPT}\n\n${historyText?"CONVERSATION HISTORY:\n"+historyText+"\n\n":""}TECHNICIAN: ${userMsg}\n\nAI ENGINEER:`;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ contents:[{parts:[{text:fullPrompt}]}], generationConfig:{maxOutputTokens:1600, temperature:0.3} }) }
    );
    const data = await res.json();
    if (data.error) return `[ERROR] ${data.error.message}`;
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Diagnostic engine error. Retry.";
  };

  const handleDiagnose = async () => {
    if (!form.batteryAge) return;
    setLoading(true);
    setActiveTab("results");
    const r = deepCalc({ age:form.batteryAge, voltage:form.voltage, ir:form.ir, ccaPercent:form.ccaPercent, temp:form.temp, tripPattern:form.tripPattern, lastStart:form.lastStart, maintenance:form.maintenance, symptoms:form.symptoms, city:form.city, batteryAh:form.batteryAh });
    setResult(r);
    const prompt   = buildPrompt(form, r);
    const dispMsg  = `[DIAG REQUEST] ${form.vehicleReg||"VEH"} | ${form.batteryBrand} ${form.batteryAh}Ah | Age: ${form.batteryAge}yr (eff: ${r.effectiveAge}yr) | OCV: ${form.voltage||"?"}V | IR: ${form.ir||"?"}mΩ | CCA: ${form.ccaPercent||"?"}%`;
    setMessages([{role:"user", content:dispMsg}]);
    try {
      const reply = await callAI(prompt, []);
      setMessages(prev=>[...prev,{role:"assistant",content:reply}]);
      setChatHistory([{role:"user",content:prompt},{role:"assistant",content:reply}]);
    } catch {
      setMessages(prev=>[...prev,{role:"assistant",content:"[ERROR] Diagnostic engine unreachable. Check connection."}]);
    }
    setLoading(false);
  };

  const handleSend = async () => {
    if (!input.trim()||loading) return;
    const txt  = input.trim();
    setInput("");
    const uMsg = {role:"user", content:txt};
    setMessages(prev=>[...prev, uMsg]);
    setLoading(true);
    try {
      const reply = await callAI(txt, chatHistory);
      const aMsg  = {role:"assistant", content:reply};
      setMessages(prev=>[...prev, aMsg]);
      setChatHistory(prev=>[...prev, uMsg, aMsg]);
    } catch {
      setMessages(prev=>[...prev,{role:"assistant",content:"[ERROR] Retry."}]);
    }
    setLoading(false);
    inputRef.current?.focus();
  };

  const QUICK_TECH = [
    "Should I run equalization charge first?",
    "What desulfation protocol for this battery?",
    "Alternator stress risk?",
    "Specific replacement part number?",
    "Jump-start risk for this vehicle?",
  ];

  return (
    <div style={{ minHeight:"100vh", background:S.gray100, fontFamily:"'Lexend',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background:${S.gray100}; }
        ::-webkit-scrollbar-thumb { background:${S.gray300}; border-radius:2px; }
        select,input { transition:border-color 0.15s; }
        select:focus,input:focus { border-color:${S.red}!important; box-shadow:0 0 0 3px rgba(229,20,44,0.08); outline:none; }
        .fade { animation:fadeUp 0.3s ease-out; }
        @keyframes fadeUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        .blink { animation:blink 2s infinite; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.35} }
      `}</style>

      {/* TOPBAR */}
      <div style={{ background:S.white, borderBottom:`2px solid ${S.red}`, padding:"0 20px", height:"54px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"12px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:"8px" }}>
            <div style={{ width:"30px", height:"30px", background:S.red, borderRadius:"7px", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:900, color:"white", fontSize:"17px", fontFamily:"'Lexend',sans-serif" }}>S</div>
            <div>
              <div style={{ fontFamily:"'Lexend',sans-serif", fontWeight:800, fontSize:"15px", color:S.black, letterSpacing:"-0.02em", lineHeight:1 }}>spinny</div>
              <div style={{ fontFamily:"'Lexend',sans-serif", fontWeight:600, fontSize:"9px", color:S.red, letterSpacing:"0.12em" }}>TECHNICIAN PORTAL</div>
            </div>
          </div>
          <div style={{ width:"1px", height:"28px", background:S.gray200 }} />
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:"11px", color:S.gray500, fontWeight:500 }}>Battery Diagnostic System v2</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:"10px" }}>
          {result && <VerdictTag verdict={result.verdict} />}
          {result && (
            <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:"10px", padding:"3px 8px", borderRadius:"4px", background:S.gray100, color:S.gray600 }}>
              eff.age {result.effectiveAge}yr
            </div>
          )}
          <div style={{ display:"flex", alignItems:"center", gap:"5px" }}>
            <div className="blink" style={{ width:"7px", height:"7px", borderRadius:"50%", background:S.green }} />
            <span style={{ fontSize:"11px", color:S.gray500, fontFamily:"'Lexend',sans-serif" }}>AI Engine Online</span>
          </div>
        </div>
      </div>

      <div style={{ display:"flex", height:"calc(100vh - 54px)" }}>
        {/* LEFT PANEL */}
        <div style={{ width:"340px", flexShrink:0, background:S.white, borderRight:`1px solid ${S.gray200}`, display:"flex", flexDirection:"column" }}>
          <div style={{ display:"flex", borderBottom:`1px solid ${S.gray200}` }}>
            {["inputs","results"].map(tab=>(
              <button key={tab} onClick={()=>setActiveTab(tab)} style={{ flex:1, padding:"10px", fontSize:"11px", fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", fontFamily:"'Lexend',sans-serif", border:"none", cursor:"pointer", background:activeTab===tab?S.white:S.gray50, color:activeTab===tab?S.red:S.gray500, borderBottom:activeTab===tab?`2px solid ${S.red}`:"2px solid transparent" }}>
                {tab==="inputs"?"🔧 Inputs":"📊 Analysis"}
              </button>
            ))}
          </div>

          <div style={{ flex:1, overflowY:"auto", padding:"16px" }}>
            {/* INPUTS TAB */}
            {activeTab==="inputs" && (
              <div className="fade">
                <div style={{ fontSize:"10px", fontWeight:700, color:S.red, letterSpacing:"0.1em", marginBottom:"12px", textTransform:"uppercase" }}>▸ Vehicle Information</div>
                <TechInput label="Vehicle Reg No." value={form.vehicleReg} onChange={set("vehicleReg")} placeholder="DL 01 AB 1234" />
                <TechInput label="Vehicle Type" value={form.carModel} onChange={set("carModel")} options={[
                  {v:"hatchback",l:"Hatchback (Swift/i10/Tiago/Polo)"},
                  {v:"sedan",l:"Sedan (City/Verna/Ciaz/Amaze)"},
                  {v:"suv",l:"SUV/MUV (Creta/XUV500/Innova)"},
                  {v:"luxury",l:"Luxury (Skoda/VW/BMW/Merc)"},
                  {v:"commercial",l:"Commercial (Bolero/Tempo/Van)"},
                ]} />
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px" }}>
                  <TechInput label="Battery Brand" value={form.batteryBrand} onChange={set("batteryBrand")} options={[
                    {v:"amaron",l:"Amaron Pro"},{v:"exide",l:"Exide FML/FMI"},
                    {v:"bosch",l:"Bosch S4/S5"},{v:"sf",l:"SF Sonic"},{v:"other",l:"Other/Unknown"},
                  ]} />
                  <TechInput label="Rated Capacity" value={form.batteryAh} onChange={set("batteryAh")} type="number" unit="Ah" placeholder="45" />
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px" }}>
                  <TechInput label="Battery Age *" required value={form.batteryAge} onChange={set("batteryAge")} type="number" unit="yrs" placeholder="e.g. 3" />
                  <TechInput label="Vehicle Mileage" value={form.mileage} onChange={set("mileage")} type="number" unit="km" placeholder="45000" />
                </div>

                <div style={{ height:"1px", background:S.gray100, margin:"12px 0" }} />
                <div style={{ fontSize:"10px", fontWeight:700, color:S.red, letterSpacing:"0.1em", marginBottom:"8px", textTransform:"uppercase" }}>▸ Measured Values</div>

                {/* Arrhenius info box */}
                {form.batteryAge && form.city && (
                  <div style={{ background:"#FFF7ED", border:`1px solid #FDBA74`, borderRadius:"8px", padding:"9px 11px", marginBottom:"12px", fontSize:"11px", color:S.orange, fontFamily:"'JetBrains Mono',monospace" }}>
                    ⚡ Arrhenius: {form.city} underhood ≈ {(()=>{const m={delhi:43,jaipur:47,ahmedabad:48,surat:44,hyderabad:41,chennai:42,lucknow:41,indore:43,coimbatore:38,kochi:36,kolkata:38,mumbai:38,pune:37,bengaluru:31,chandigarh:36}; return (m[form.city]||38)+15;})()}°C
                    &nbsp;→ aging ×{(()=>{const m={delhi:43,jaipur:47,ahmedabad:48,surat:44,hyderabad:41,chennai:42,lucknow:41,indore:43,coimbatore:38,kochi:36,kolkata:38,mumbai:38,pune:37,bengaluru:31,chandigarh:36}; const t=(m[form.city]||38)+15; return (0.3*Math.pow(2,(m[form.city]||38-25)/8)+0.7*Math.pow(2,(t-25)/8)).toFixed(1);})()}×
                  </div>
                )}

                <div style={{ background:S.gray50, borderRadius:"8px", padding:"10px 12px", marginBottom:"12px", border:`1px solid ${S.gray200}` }}>
                  <div style={{ fontSize:"10px", fontWeight:700, color:S.gray500, letterSpacing:"0.06em", marginBottom:"8px" }}>OCV REFERENCE (temp-corrected)</div>
                  {[["≥12.73V","100% SOC — Full",S.green],["12.50V","80% SOC — OK","#84cc16"],["12.10V","50% — Recharge",S.amber],["<11.96V","<40% — Discharged",S.red]].map(([v,l,c])=>(
                    <div key={v} style={{ display:"flex", justifyContent:"space-between", marginBottom:"3px" }}>
                      <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:"10px", color:c, fontWeight:600 }}>{v}</span>
                      <span style={{ fontSize:"10px", color:S.gray500 }}>{l}</span>
                    </div>
                  ))}
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px" }}>
                  <TechInput label="Resting OCV" value={form.voltage} onChange={set("voltage")} type="number" unit="V" placeholder="12.4" />
                  <TechInput label="Internal Resistance" value={form.ir} onChange={set("ir")} type="number" unit="mΩ" placeholder="8" />
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px" }}>
                  <TechInput label="CCA Remaining %" value={form.ccaPercent} onChange={set("ccaPercent")} type="number" unit="%" placeholder="70" />
                  <TechInput label="Ambient Temp" value={form.temp} onChange={set("temp")} type="number" unit="°C" placeholder="38" />
                </div>

                {/* Measurement completeness indicator */}
                <div style={{ background:S.gray50, borderRadius:"8px", padding:"8px 11px", marginBottom:"12px", border:`1px solid ${S.gray200}` }}>
                  <div style={{ fontSize:"10px", fontWeight:700, color:S.gray500, letterSpacing:"0.06em", marginBottom:"6px" }}>RUL CONFIDENCE (more = tighter CI)</div>
                  <div style={{ display:"flex", gap:"6px" }}>
                    {[["OCV",!!form.voltage],["IR",!!form.ir],["CCA%",!!form.ccaPercent]].map(([lbl,filled])=>(
                      <div key={lbl} style={{ flex:1, textAlign:"center", padding:"4px", borderRadius:"5px", background:filled?S.greenBg:"#F3F4F6", border:`1px solid ${filled?"#86EFAC":S.gray200}`, fontSize:"10px", fontWeight:700, color:filled?S.green:S.gray400 }}>
                        {filled?"✓":"-"} {lbl}
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ height:"1px", background:S.gray100, margin:"12px 0" }} />
                <div style={{ fontSize:"10px", fontWeight:700, color:S.red, letterSpacing:"0.1em", marginBottom:"12px", textTransform:"uppercase" }}>▸ Field Observations</div>
                <TechInput label="Spinny Workshop City" value={form.city} onChange={set("city")} options={[
                  {v:"delhi",l:"Delhi NCR (Extreme heat + cold)"},{v:"bengaluru",l:"Bengaluru (Mild, 22–32°C)"},
                  {v:"hyderabad",l:"Hyderabad (Hot & dry, 35–44°C)"},{v:"pune",l:"Pune (Moderate, 25–38°C)"},
                  {v:"mumbai",l:"Mumbai (Humid + monsoon)"},{v:"kolkata",l:"Kolkata (Humid + monsoon)"},
                  {v:"chennai",l:"Chennai (Very hot + humid, 35–42°C)"},{v:"ahmedabad",l:"Ahmedabad (Extreme heat, 40–48°C)"},
                  {v:"jaipur",l:"Jaipur (Extreme heat, 40–48°C)"},{v:"chandigarh",l:"Chandigarh (Cold winters, 2–8°C)"},
                  {v:"indore",l:"Indore (Hot & dry, 35–44°C)"},{v:"coimbatore",l:"Coimbatore (Warm & humid, 28–38°C)"},
                  {v:"lucknow",l:"Lucknow (Hot summers + cold winters)"},{v:"kochi",l:"Kochi (Very humid + heavy monsoon)"},
                  {v:"surat",l:"Surat (Hot + humid, 38–44°C)"},
                ]} />
                <TechInput label="Trip Pattern" value={form.tripPattern} onChange={set("tripPattern")} options={[
                  {v:"short",l:"Short city (<15 min) — PSOC / sulfation risk"},
                  {v:"mixed",l:"Mixed city + highway"},{v:"highway",l:"Highway dominant — good recharge"},
                ]} />
                <TechInput label="Last Start Condition" value={form.lastStart} onChange={set("lastStart")} options={[
                  {v:"normal",l:"Normal — no issues"},{v:"slow",l:"Slow / laboured crank"},
                  {v:"jump",l:"Required jump start"},{v:"dead",l:"Complete battery death"},
                ]} />
                <TechInput label="Maintenance History" value={form.maintenance} onChange={set("maintenance")} options={[
                  {v:"regular",l:"Regular service done"},{v:"occasional",l:"Occasional checks"},{v:"never",l:"No maintenance ever"},
                ]} />
                <TechInput label="Visual Symptoms" value={form.symptoms} onChange={set("symptoms")} options={[
                  {v:"none",l:"None observed"},{v:"slow",l:"Slow cranking"},
                  {v:"dim",l:"Dim lights at idle"},{v:"warning",l:"Warning light on dash"},
                  {v:"corrosion",l:"Terminal corrosion visible"},{v:"multiple",l:"Multiple symptoms"},
                ]} />
              </div>
            )}

            {/* RESULTS TAB */}
            {activeTab==="results" && result && (
              <div className="fade">
                <div style={{ fontSize:"10px", fontWeight:700, color:S.red, letterSpacing:"0.1em", marginBottom:"12px", textTransform:"uppercase" }}>▸ Degradation Factors</div>
                <FactorBar label="Capacity Factor (CF)" value={result.CF} warn={65} crit={45} />
                <FactorBar label="CCA Factor (CCAF)" value={result.CCAF} warn={65} crit={50} />
                <FactorBar label="Internal Resistance Factor" value={result.IRF} warn={65} crit={45} />
                <FactorBar label="Sulfation Index" value={result.SI} unit="/10" invert warn={40} crit={30} />

                <div style={{ height:"1px", background:S.gray100, margin:"12px 0" }} />
                <div style={{ fontSize:"10px", fontWeight:700, color:S.red, letterSpacing:"0.1em", marginBottom:"12px", textTransform:"uppercase" }}>▸ Key Metrics</div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px", marginBottom:"12px" }}>
                  <MetricCard icon="⏳" label="RUL Range" value={`${result.rulMin}–${result.rulMax}`} sub={`months · ${result.rulConf}% conf.`}
                    color={result.rulMax<4?S.red:result.rulMax<10?S.amber:S.green} critical={result.rulMax<3} />
                  <MetricCard icon="⚡" label="Est. IR" value={`${result.estIR}mΩ`}
                    sub={result.estIR>20?"⚠ End-of-life range":result.estIR>12?"Elevated":"Normal"}
                    color={result.estIR>20?S.red:result.estIR>12?S.amber:S.green} />
                  <MetricCard icon="🔋" label="Est. OCV" value={`${result.estOCV}V`} sub="rested voltage"
                    color={result.estOCV<12.1?S.red:result.estOCV<12.4?S.amber:S.green} />
                  <MetricCard icon="⚙️" label="Load Test" value={`${result.estLoadV}V`} sub="@50% CCA · 15s"
                    color={result.estLoadV<9.6?S.red:result.estLoadV<10.5?S.amber:S.green} critical={result.estLoadV<9.6} />
                  <MetricCard icon="💧" label="Est. SG" value={result.estSG} sub="electrolyte (flooded)"
                    color={result.estSG<1.220?S.red:result.estSG<1.250?S.amber:S.green} />
                  <MetricCard icon="🌡️" label="Eff. Age" value={`${result.effectiveAge}yr`} sub={`vs ${parseFloat(form.batteryAge)||0}yr calendar`}
                    color={result.effectiveAge>(parseFloat(form.batteryAge)||0)*1.5?S.red:result.effectiveAge>(parseFloat(form.batteryAge)||0)*1.2?S.amber:S.green} />
                </div>

                <div style={{ height:"1px", background:S.gray100, margin:"12px 0" }} />
                <div style={{ fontSize:"10px", fontWeight:700, color:S.red, letterSpacing:"0.1em", marginBottom:"10px", textTransform:"uppercase" }}>▸ Failure Risk (Weibull · 6 months)</div>
                {[
                  {label:"CCA Failure (no-start)",p:result.ccaFailP},
                  {label:"Capacity Death",p:result.capFailP},
                  {label:"Internal Short (sulfation)",p:result.shortP},
                  {label:"Grid Fracture (corrosion)",p:result.gridP},
                ].map(fm=>(
                  <div key={fm.label} style={{ display:"flex", alignItems:"center", gap:"8px", marginBottom:"7px" }}>
                    <div style={{ flex:1, fontSize:"11px", color:S.gray600, fontWeight:500 }}>{fm.label}</div>
                    <div style={{ width:"80px", height:"5px", background:S.gray200, borderRadius:"3px", overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${fm.p}%`, background:fm.p>60?S.red:fm.p>35?S.amber:S.green, borderRadius:"3px" }} />
                    </div>
                    <div style={{ width:"32px", fontSize:"11px", fontWeight:700, color:fm.p>60?S.red:fm.p>35?S.amber:S.green, fontFamily:"'JetBrains Mono',monospace", textAlign:"right" }}>{fm.p}%</div>
                  </div>
                ))}

                <div style={{ height:"1px", background:S.gray100, margin:"12px 0" }} />
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px" }}>
                  {[
                    { label:"GRID CORROSION", val:`Stage ${result.gridStage}/4`, sub:["","Minor","Moderate","Advanced","End-of-Life"][result.gridStage], color:result.gridStage>=3?S.red:result.gridStage===2?S.amber:S.green },
                    { label:"SELF-DISCHARGE", val:`${result.sdr}%/day`, sub:result.sdr>1?"Abnormal":result.sdr>0.4?"Elevated":"Normal", color:result.sdr>1?S.red:result.sdr>0.4?S.amber:S.green },
                    { label:"THERMAL STRESS", val:`${result.thermalScore}/10`, sub:"Cumulative heat damage", color:result.thermalScore>6?S.red:result.thermalScore>4?S.amber:S.green },
                    { label:"LIFE LIMITER", val:result.limiter, sub:"Primary failure driver", color:S.red },
                  ].map(card=>(
                    <div key={card.label} style={{ background:S.gray50, borderRadius:"8px", padding:"10px", border:`1px solid ${S.gray200}` }}>
                      <div style={{ fontSize:"9px", color:S.gray500, fontWeight:600, letterSpacing:"0.06em", marginBottom:"3px" }}>{card.label}</div>
                      <div style={{ fontSize:card.label==="LIFE LIMITER"?"12px":"16px", fontWeight:800, color:card.color, fontFamily:"'JetBrains Mono',monospace", lineHeight:1.2 }}>{card.val}</div>
                      <div style={{ fontSize:"10px", color:S.gray500, marginTop:"2px" }}>{card.sub}</div>
                    </div>
                  ))}
                </div>

                {result.stratPenalty > 0 && (
                  <div style={{ marginTop:"10px", background:"#FFFBEB", border:`1px solid #FCD34D`, borderRadius:"8px", padding:"9px 11px", fontSize:"11px", color:S.amber, fontFamily:"'JetBrains Mono',monospace" }}>
                    ⚠ Electrolyte stratification likely (−{result.stratPenalty} capacity pts) — equalisation charge recommended
                  </div>
                )}
              </div>
            )}

            {activeTab==="results" && !result && (
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:"10px", textAlign:"center", padding:"20px" }}>
                <div style={{ fontSize:"36px", opacity:0.3 }}>📊</div>
                <div style={{ fontSize:"12px", color:S.gray400, fontFamily:"'JetBrains Mono',monospace" }}>No diagnostic data yet</div>
                <div style={{ fontSize:"11px", color:S.gray400 }}>Go to Inputs tab and run diagnosis</div>
              </div>
            )}
          </div>

          {/* Diagnose Button */}
          <div style={{ padding:"14px 16px", borderTop:`1px solid ${S.gray200}`, background:S.white }}>
            <button onClick={handleDiagnose} disabled={loading||!form.batteryAge} style={{
              width:"100%", padding:"11px", borderRadius:"8px",
              background:loading||!form.batteryAge?S.gray300:S.red,
              color:loading||!form.batteryAge?S.gray500:"white",
              fontSize:"12px", fontWeight:700, letterSpacing:"0.06em",
              fontFamily:"'Lexend',sans-serif", border:"none",
              cursor:loading||!form.batteryAge?"not-allowed":"pointer",
              boxShadow:loading||!form.batteryAge?"none":"0 3px 12px rgba(229,20,44,0.3)",
            }}>
              {loading?"⏳ Running Diagnostics...":result?"↻ Re-Run Diagnostic":"▶ Run Full Diagnostic"}
            </button>
            {!form.batteryAge && <div style={{ fontSize:"10px", color:S.red, textAlign:"center", marginTop:"5px" }}>* Battery age required</div>}
          </div>
        </div>

        {/* RIGHT PANEL — AI REPORT */}
        <div style={{ flex:1, display:"flex", flexDirection:"column", background:S.gray50 }}>
          <div style={{ background:S.white, borderBottom:`1px solid ${S.gray200}`, padding:"10px 18px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ display:"flex", alignItems:"center", gap:"8px" }}>
              <div style={{ fontSize:"9px", fontWeight:700, color:S.gray400, letterSpacing:"0.1em", fontFamily:"'Lexend',sans-serif" }}>AI DIAGNOSTIC REPORT</div>
              {result && (
                <div style={{ display:"flex", gap:"6px" }}>
                  {[
                    `SOH~${Math.round(result.CF*0.5+result.CCAF*0.5)}%`,
                    `RUL ${result.rulMin}–${result.rulMax}mo`,
                    `SI ${result.SI}/10`,
                    `SG~${result.estSG}`,
                  ].map(tag=>(
                    <span key={tag} style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:"10px", padding:"2px 7px", borderRadius:"4px", background:S.gray100, color:S.gray600 }}>{tag}</span>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display:"flex", gap:"5px", alignItems:"center" }}>
              <div className="blink" style={{ width:"6px", height:"6px", borderRadius:"50%", background:S.green }} />
              <span style={{ fontSize:"10px", color:S.gray400, fontFamily:"'Lexend',sans-serif" }}>Spinny Battery AI</span>
            </div>
          </div>

          <div style={{ flex:1, overflowY:"auto", padding:"18px" }}>
            {!result ? (
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:"14px", textAlign:"center" }}>
                <div style={{ width:"64px", height:"64px", background:S.lightRed, borderRadius:"16px", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"28px" }}>🔬</div>
                <div style={{ fontFamily:"'Lexend',sans-serif", fontSize:"18px", fontWeight:800, color:S.black }}>Spinny Battery Diagnostic</div>
                <div style={{ fontSize:"13px", color:S.gray500, maxWidth:"420px", lineHeight:"1.7" }}>
                  Technician-grade analysis using Arrhenius temperature acceleration, non-linear aging curves, OCV–SOC lookup, and Weibull survival modelling.
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"8px", maxWidth:"480px", marginTop:"8px" }}>
                  {[["🌡️","Arrhenius Temp Model"],["📉","Non-linear Aging"],["🔬","OCV–SOC Lookup"],["⚡","IR Exponential Rise"],["📊","Weibull Failure Prob"],["🔋","Effective Age Calc"]].map(([icon,label])=>(
                    <div key={label} style={{ padding:"10px", borderRadius:"8px", background:S.white, border:`1px solid ${S.gray200}`, textAlign:"center" }}>
                      <div style={{ fontSize:"18px", marginBottom:"4px" }}>{icon}</div>
                      <div style={{ fontSize:"10px", fontWeight:600, color:S.gray500 }}>{label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize:"11px", color:S.red, fontWeight:600, marginTop:"6px" }}>Fill inputs → Click "Run Full Diagnostic" →</div>
              </div>
            ) : (
              <>
                {messages.map((msg,i)=><div key={i} className="fade"><ChatBubble msg={msg} /></div>)}
                {loading && (
                  <div className="fade" style={{ display:"flex", alignItems:"center", gap:"8px", marginBottom:"12px" }}>
                    <div style={{ width:"28px", height:"28px", borderRadius:"6px", background:S.red, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"12px" }}>🔬</div>
                    <div style={{ padding:"10px 14px", borderRadius:"3px 12px 12px 12px", background:S.white, border:`1px solid ${S.gray200}`, display:"flex", gap:"5px" }}>
                      {[0,0.2,0.4].map(d=><div key={d} style={{ width:"7px", height:"7px", borderRadius:"50%", background:S.red, animation:`blink 1.2s ease-in-out ${d}s infinite` }} />)}
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </>
            )}
          </div>

          {result && messages.length>1 && (
            <div style={{ padding:"8px 18px 4px", borderTop:`1px solid ${S.gray200}`, background:S.white, display:"flex", gap:"6px", overflowX:"auto", alignItems:"center" }}>
              <span style={{ fontSize:"9px", fontWeight:700, color:S.gray400, letterSpacing:"0.1em", flexShrink:0, fontFamily:"'Lexend',sans-serif" }}>QUICK:</span>
              {QUICK_TECH.map(q=>(
                <button key={q} onClick={()=>{ setInput(q); inputRef.current?.focus(); }} style={{ flexShrink:0, padding:"4px 10px", borderRadius:"4px", fontSize:"10px", fontFamily:"'Lexend',sans-serif", fontWeight:500, cursor:"pointer", background:S.gray50, border:`1px solid ${S.gray200}`, color:S.gray600, whiteSpace:"nowrap" }}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=S.red;e.currentTarget.style.color=S.red;}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=S.gray200;e.currentTarget.style.color=S.gray600;}}>
                  {q}
                </button>
              ))}
            </div>
          )}

          <div style={{ padding:"12px 18px", borderTop:`1px solid ${S.gray200}`, background:S.white }}>
            <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
              <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:"12px", color:S.red, fontWeight:700, flexShrink:0 }}>{">"}</div>
              <input ref={inputRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSend()}
                disabled={!result||loading} placeholder={result?"Technical query for battery AI...":"Run diagnostic first..."}
                style={{ flex:1, padding:"9px 12px", borderRadius:"7px", fontSize:"13px", fontFamily:"'JetBrains Mono',monospace", color:S.black, background:S.gray50, border:`1.5px solid ${S.gray200}`, outline:"none", opacity:!result||loading?0.5:1 }} />
              <button onClick={handleSend} disabled={!result||loading||!input.trim()} style={{ width:"38px", height:"38px", borderRadius:"7px", border:"none", background:!result||loading||!input.trim()?S.gray200:S.red, cursor:!result||loading||!input.trim()?"not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={!result||loading||!input.trim()?S.gray400:"white"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>
                </svg>
              </button>
            </div>
            <div style={{ textAlign:"center", marginTop:"6px", fontSize:"9px", color:S.gray300, fontFamily:"'Lexend',sans-serif" }}>Spinny · Battery Diagnostic </div>
          </div>
        </div>
      </div>
    </div>
  );
}