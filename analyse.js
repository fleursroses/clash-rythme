// Analyse d'une prod : tempo (BPM), position du 1er temps fort, et mesure où la batterie démarre.
// Utilisé une fois pour fabriquer prods.json (outil analyse.html).
const HOP = 512;

async function bandEnvelope(buffer, type, freq){
  const sr = buffer.sampleRate, len = buffer.length;
  const off = new OfflineAudioContext(1, len, sr);
  const src = off.createBufferSource(); src.buffer = buffer;
  let node = src;
  if (type){ const f = off.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = 0.7; node.connect(f); node = f; }
  node.connect(off.destination); src.start();
  const out = (await off.startRendering()).getChannelData(0);
  const n = Math.floor(len / HOP), e = new Float32Array(n);
  for (let i = 0; i < n; i++){ let s = 0; for (let j = i * HOP, k = j + HOP; j < k; j++) s += out[j] * out[j]; e[i] = Math.log(1e-9 + s); }
  return e;
}
function onset(e){
  const o = new Float32Array(e.length);
  for (let i = 1; i < e.length; i++) o[i] = Math.max(0, e[i] - e[i - 1]);
  // retire la moyenne locale
  const w = 16, r = new Float32Array(o.length);
  for (let i = 0; i < o.length; i++){ let s = 0, c = 0; for (let j = Math.max(0, i - w); j < Math.min(o.length, i + w); j++){ s += o[j]; c++; } r[i] = Math.max(0, o[i] - s / c); }
  return r;
}
function interp(a, x){ const i = Math.floor(x); if (i < 0 || i + 1 >= a.length) return 0; const f = x - i; return a[i] * (1 - f) + a[i + 1] * f; }

async function analyseBuffer(buffer){
  const fps = buffer.sampleRate / HOP;
  const [full, low, mid] = await Promise.all([bandEnvelope(buffer), bandEnvelope(buffer, 'lowpass', 150), bandEnvelope(buffer, 'bandpass', 2500)]);
  const oF = onset(full), oL = onset(low), oM = onset(mid);
  const comb = oF.map((v, i) => v + oL[i] + oM[i]);
  // 1) tempo grossier par autocorrélation (60-180 BPM)
  let best = {score: -1, bpm: 90};
  for (let bpm = 60; bpm <= 180; bpm += 0.5){
    const lag = fps * 60 / bpm; let s = 0;
    for (let i = 0; i + lag * 4 < comb.length; i += 2) s += comb[i] * (interp(comb, i + lag) + 0.5 * interp(comb, i + lag * 2) + 0.25 * interp(comb, i + lag * 4));
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 90) / 0.9, 2));   // préférence douce autour de 90
    if (s * w > best.score) best = {score: s * w, bpm};
  }
  // ramène dans 65-115 (le rap se compte en "demi-tempo" pour la trap/drill)
  const fold = b => { while (b >= 115) b /= 2; while (b < 60) b *= 2; return b; };
  // force de la grille en doubles-croches : départage les erreurs ×1,5 (fréquentes en trap/drill)
  const mean = comb.reduce((a, b) => a + b, 0) / comb.length;
  const grid16 = c => { let bs = -1; for (let b = c - 0.6; b <= c + 0.6; b += 0.01){ const p = fps * 60 / b; for (let ph = 0; ph < p; ph += 1){ let s = 0, n = 0; for (let x = ph; x < comb.length; x += p / 4){ s += interp(comb, x); n++; } bs = Math.max(bs, s / n); } } return bs / mean; };
  let bpm = fold(best.bpm), g0 = grid16(bpm);
  for (const r of [2/3, 4/3, 3/4, 3/2]){ const c = fold(bpm * r), g = grid16(c); if (g > g0 * 1.3){ bpm = c; g0 = g; } }
  // 2) tempo fin + phase par peigne sur toute la prod
  let fine = {score: -1};
  for (let b = bpm - 1.5; b <= bpm + 1.5; b += 0.02){
    const period = fps * 60 / b;
    for (let ph = 0; ph < period; ph += 0.5){
      let s = 0;
      for (let x = ph; x < comb.length; x += period / 2) s += interp(comb, x);   // temps + contretemps
      if (s > fine.score) fine = {score: s, bpm: b, ph};
    }
  }
  bpm = Math.round(fine.bpm * 100) / 100;
  const beat = fps * 60 / bpm;
  // la phase trouvée peut tomber sur un contretemps : choisir entre ph et ph+beat/2
  const sumAt = (arr, ph) => { let s = 0; for (let x = ph; x < arr.length; x += beat) s += interp(arr, x); return s; };
  let ph = fine.ph % beat;
  if (sumAt(comb, ph + beat / 2) > sumAt(comb, ph)) ph = (ph + beat / 2) % beat;
  // 3) temps fort : parmi les 4 temps, celui avec le plus de grosse caisse et le moins de caisse claire
  const bar = beat * 4; let down = {score: -1e9, ph};
  for (let k = 0; k < 4; k++){
    const p = (ph + k * beat) % bar; let s = 0;
    for (let x = p; x < comb.length; x += bar) s += interp(oL, x) - 0.6 * interp(oM, x) + 0.6 * interp(oM, x + beat) + 0.6 * interp(oM, x + 3 * beat);
    if (s > down.score) down = {score: s, ph: p};
  }
  const offset = down.ph / fps;
  // 4) mesure où la batterie démarre (énergie des graves)
  const barSec = 240 / bpm, nBars = Math.floor((buffer.duration - offset) / barSec);
  const lowE = [];
  for (let b = 0; b < nBars; b++){ let s = 0, c = 0; for (let x = (offset + b * barSec) * fps; x < (offset + (b + 1) * barSec) * fps; x++){ s += interp(oL, x); c++; } lowE.push(s / c); }
  const med = lowE.slice().sort((a, b) => a - b)[Math.floor(lowE.length / 2)] || 0;
  let drop = lowE.findIndex(v => v > med * 0.5); if (drop < 0) drop = 0;
  return {bpm, offset: Math.round(offset * 1000) / 1000, drop, bars: nBars, duration: Math.round(buffer.duration * 10) / 10};
}
