#!/usr/bin/env node

// A baseline holds results for a specific set of evals run against a specific
// model matrix. When either drifts, reports keep comparing against it instead of
// failing, so a stale baseline reads as a valid one. Staleness is the real target
// here; a missing baseline is at least visible.

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const skillsRoot = path.join(repoRoot, "skills");
const errors = [];

const REQUIRED_BASELINE_FILES = [
  "baseline.json",
  "model-matrix.json",
  "aggregate-benchmark.json",
];

// Fields that change what a run measures. Presentation-only fields are ignored.
const MATRIX_FIELDS = ["models", "configurations", "repetitions", "judge_model"];

function addError(message) {
  errors.push(message);
}

async function readJsonFile(filePath, context) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    addError(`${context} could not be read: ${relative(filePath)} (${error.message})`);
    return null;
  }
}

function relative(target) {
  return path.relative(repoRoot, target);
}

async function listDirectories(target) {
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function findEvalSuites() {
  const suites = [];
  for (const skill of await listDirectories(skillsRoot)) {
    const evalsDir = path.join(skillsRoot, skill, "evals");
    for (const suite of await listDirectories(evalsDir)) {
      const suiteDir = path.join(evalsDir, suite);
      try {
        await fs.access(path.join(suiteDir, "evals.json"));
        suites.push({ skill, suite, suiteDir });
      } catch {
        // Not an eval suite; the runner ignores these too.
      }
    }
  }
  return suites.sort((left, right) => relative(left.suiteDir).localeCompare(relative(right.suiteDir)));
}

function promoteHint({ skill, suite }) {
  return `npm run eval:baseline -- --skill ${skill} --suite ${suite} --iteration iteration-1`;
}

// Compared as a set: reordering the model list does not change what was measured.
function sameValue(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    const sortedLeft = [...left].map(String).sort();
    const sortedRight = [...right].map(String).sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
  }
  return left === right;
}

function describe(value) {
  return Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
}

function checkMatrix(suite, current, baseline) {
  for (const field of MATRIX_FIELDS) {
    if (!sameValue(current?.[field], baseline?.[field])) {
      addError(
        `${suite.skill}/${suite.suite}: baseline was run with a different ${field} ` +
          `(baseline ${describe(baseline?.[field])}, suite now ${describe(current?.[field])}). ` +
          `Re-run the suite and promote it: ${promoteHint(suite)}`
      );
    }
  }
}

function checkEvalSet(suite, evalsFile, benchmark) {
  const expected = (evalsFile.evals ?? []).map(
    (item) => `${item.id}:${item.name ?? `eval-${item.id}`}`
  );
  const recorded = (benchmark.evals ?? []).map(
    (item) => `${item.eval_id}:${item.eval_name ?? `eval-${item.eval_id}`}`
  );

  const missing = expected.filter((item) => !recorded.includes(item));
  const extra = recorded.filter((item) => !expected.includes(item));

  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length > 0 ? `not covered by the baseline: ${missing.join(", ")}` : null,
      extra.length > 0 ? `in the baseline but no longer defined: ${extra.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    addError(
      `${suite.skill}/${suite.suite}: baseline does not match the current evals (${details}). ` +
        `Re-run the suite and promote it: ${promoteHint(suite)}`
    );
  }
}

async function validateSuite(suite) {
  const baselineDir = path.join(suite.suiteDir, "baselines");

  for (const file of REQUIRED_BASELINE_FILES) {
    try {
      await fs.access(path.join(baselineDir, file));
    } catch {
      addError(
        `${suite.skill}/${suite.suite}: missing baseline file ${file}. ` +
          `Run the suite, then promote it: ${promoteHint(suite)}`
      );
      return;
    }
  }

  const evalsFile = await readJsonFile(path.join(suite.suiteDir, "evals.json"), "evals.json");
  const currentMatrix = await readJsonFile(
    path.join(suite.suiteDir, "model-matrix.json"),
    "model-matrix.json"
  );
  const baselineMatrix = await readJsonFile(
    path.join(baselineDir, "model-matrix.json"),
    "baseline model-matrix.json"
  );
  const benchmark = await readJsonFile(
    path.join(baselineDir, "aggregate-benchmark.json"),
    "baseline aggregate-benchmark.json"
  );

  if (!evalsFile || !currentMatrix || !baselineMatrix || !benchmark) return;

  checkMatrix(suite, currentMatrix, baselineMatrix);
  checkEvalSet(suite, evalsFile, benchmark);
}

async function main() {
  const suites = await findEvalSuites();

  if (suites.length === 0) {
    console.log("No eval suites found.");
    process.exit(0);
  }

  for (const suite of suites) {
    await validateSuite(suite);
  }

  if (errors.length > 0) {
    console.error("Eval baseline validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Eval baseline validation passed for ${suites.length} suites.`);
}

await main();
