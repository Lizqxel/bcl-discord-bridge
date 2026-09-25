import { poseCollide } from './src/bcl/maps/ColliderMap.ts';
for (const [name, map] of [['SKELD', 0], ['MIRA', 1], ['POLUS', 2], ['AIRSHIP', 4], ['FUNGLE', 5]]) {
  let hits = 0; const n = 2000; const t0 = performance.now();
  for (let i = 0; i < n; i++) { const a = { x: Math.random() * 40 - 20, y: Math.random() * 30 - 20 }; const b = { x: a.x + Math.random() * 6 - 3, y: a.y + Math.random() * 6 - 3 }; if (poseCollide(a, b, map, [])) hits++; }
  const ms = (performance.now() - t0) / n; console.log(`${name}: ${ms.toFixed(3)} ms/call, hits ${hits}/${n}`);
}