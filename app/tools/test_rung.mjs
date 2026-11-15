#!/usr/bin/env node
/**
 * 行为判级 · 层 1 规则单测（设计稿《行为判级-测试设计-v0.1》）
 *
 *   node tools/test_rung.mjs
 *
 * 只测规则，不起服务、不动 data/cards.db（用 :memory:）。
 * 升降级都用现有规则（用户 2026-11-14 定：全量启用，不新增规则）。
 */
import { openDb, applyEvent, adjustRung, getState } from "../src/db.mjs";

const DAY = 24 * 3600 * 1000;
const db = openDb(":memory:");
let pass = 0, fail = 0, skip = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  → " + detail : ""}`); }
}
function setConcept(id, { state = "taught", s = 0.2, rung = 0, rungAt = 0, types = [], rungTypes = [] } = {}) {
  db.prepare(`INSERT OR REPLACE INTO concept_state
    (concept_id,state,s,corrects,types_json,last_seen,updated_at,rung,rung_types_json,rung_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, state, s, 0, JSON.stringify(types), Date.now(), Date.now(), rung, JSON.stringify(rungTypes), rungAt);
}

console.log("层 1：档位规则\n");

// 1. 两种题型 + 隔 8 天 → 升 1 档
setConcept("c1", { rungAt: Date.now() - 8 * DAY, rungTypes: [] });
applyEvent(db, "c1", "taught");
applyEvent(db, "c1", "correct", { type: "recall" });
applyEvent(db, "c1", "correct", { type: "cause" });
check("两种题型 + 隔 8 天 → +1 档", getState(db, "c1").rung === 1, `rung=${getState(db, "c1").rung}`);

// 2. 两种题型 + 同一天（rung_at=今天）→ 不升
setConcept("c2", { rungAt: Date.now(), rungTypes: [] });
applyEvent(db, "c2", "correct", { type: "recall" });
applyEvent(db, "c2", "correct", { type: "cause" });
check("两种题型 + 同一天 → 不升", getState(db, "c2").rung === 0, `rung=${getState(db, "c2").rung}`);

// 3. 只答对一种题型 ×3 → 不升
setConcept("c3", { rungAt: Date.now() - 8 * DAY });
for (let i = 0; i < 3; i++) applyEvent(db, "c3", "correct", { type: "recall" });
check("只答对一种题型 ×3 → 不升", getState(db, "c3").rung === 0, `rung=${getState(db, "c3").rung}`);

// 4. 答错：掌握度降、档位不变
setConcept("c4", { s: 0.6, rung: 1, rungAt: Date.now() - 8 * DAY });
const before = getState(db, "c4").s;
applyEvent(db, "c4", "wrong");
const st4 = getState(db, "c4");
check("答错 → 掌握度降", st4.s < before, `${before} → ${st4.s}`);
check("答错 → 档位不变", st4.rung === 1, `rung=${st4.rung}`);

// 5. 手动 +1 / -1 / 封顶
setConcept("c5", { rung: 0 });
const up = adjustRung(db, "c5", 1);
const down = adjustRung(db, "c5", -1);
const floor = adjustRung(db, "c5", -1);
check("手动 +1", up.rung === 1, `rung=${up.rung}`);
check("手动 -1", down.rung === 0, `rung=${down.rung}`);
check("手动 -1 不低于 G0", floor.rung === 0, `rung=${floor.rung}`);

// 6. G4 封顶
setConcept("c6", { rung: 4 });
const capped = adjustRung(db, "c6", 1);
check("G4 再升 → 仍是 G4", capped.rung === 4, `rung=${capped.rung}`);

// 7. 连续两次答错 → 自动降一档（已实装）
setConcept("c7", { s: 0.8, rung: 2 });
applyEvent(db, "c7", "wrong");
applyEvent(db, "c7", "wrong");
const st7 = getState(db, "c7");
check("连续两次答错 → 自动降一档", st7.rung === 1, `rung=${st7.rung}`);

console.log(`\n结果：通过 ${pass} · 失败 ${fail} · 跳过 ${skip}`);
process.exit(fail ? 1 : 0);
